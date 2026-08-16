#include <cuda_runtime.h>

#include <algorithm>
#include <chrono>
#include <cinttypes>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr uint32_t kLcgMul = 1664525u;
constexpr uint32_t kLcgAdd = 1013904223u;
constexpr uint32_t kMixMul1 = 0x7feb352du;
constexpr uint32_t kMixMul2 = 0x846ca68bu;

struct Options {
    std::string mode = "all";
    double seconds = 3.0;
    size_t l2_mib = 32;
    size_t vram_mib = 1024;
    int target_sm = -1;
    int compute_iterations = 8192;
    int l2_iterations = 4096;
    int atomic_iterations = 256;
};

struct Affine32 {
    uint32_t mul;
    uint32_t add;
};

[[noreturn]] void fail_cuda(cudaError_t err, const char *expr, const char *file,
                            int line) {
    std::fprintf(stderr, "CUDA_ERROR expr=%s file=%s line=%d code=%d text=%s\n",
                 expr, file, line, static_cast<int>(err),
                 cudaGetErrorString(err));
    std::exit(2);
}

#define CUDA_OK(expr)                                                           \
    do {                                                                        \
        cudaError_t _err = (expr);                                              \
        if (_err != cudaSuccess)                                                \
            fail_cuda(_err, #expr, __FILE__, __LINE__);                         \
    } while (0)

__host__ __device__ inline uint32_t mix32(uint32_t x) {
    x ^= x >> 16;
    x *= kMixMul1;
    x ^= x >> 15;
    x *= kMixMul2;
    x ^= x >> 16;
    return x;
}

__device__ __forceinline__ uint32_t read_smid() {
    uint32_t smid;
    asm volatile("mov.u32 %0, %%smid;" : "=r"(smid));
    return smid;
}

__device__ __forceinline__ uint32_t load_global_cg(const uint32_t *ptr) {
    uint32_t value;
    asm volatile("ld.global.cg.u32 %0, [%1];" : "=r"(value) : "l"(ptr));
    return value;
}

__device__ __forceinline__ void store_global_wb(uint32_t *ptr,
                                                 uint32_t value) {
    asm volatile("st.global.wb.u32 [%0], %1;" : : "l"(ptr), "r"(value) : "memory");
}

__device__ __forceinline__ uint64_t atomic_add_global_u64(
    uint64_t *ptr, uint64_t value) {
    uint64_t old;
    asm volatile("atom.global.add.u64 %0, [%1], %2;"
                 : "=l"(old)
                 : "l"(ptr), "l"(value)
                 : "memory");
    return old;
}

__device__ __forceinline__ bool selected_sm(int target_sm, uint32_t smid) {
    return target_sm < 0 || static_cast<uint32_t>(target_sm) == smid;
}

__global__ void init_pattern_kernel(uint32_t *data, size_t words,
                                    uint32_t salt) {
    size_t stride = static_cast<size_t>(gridDim.x) * blockDim.x;
    size_t idx = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    for (; idx < words; idx += stride)
        data[idx] = mix32(static_cast<uint32_t>(idx) ^ salt);
}

__global__ void compute_kernel(uint32_t *output, uint64_t *sm_hits,
                               uint64_t *work_items, int iterations,
                               int target_sm) {
    uint32_t smid = read_smid();
    if (!selected_sm(target_sm, smid))
        return;

    uint32_t tid = blockIdx.x * blockDim.x + threadIdx.x;
    uint32_t x = mix32(tid ^ 0xa5a5f00du);
    for (int i = 0; i < iterations; ++i) {
        asm volatile("mad.lo.u32 %0, %0, %1, %2;"
                     : "+r"(x)
                     : "r"(kLcgMul), "r"(kLcgAdd));
    }
    output[tid] = x;
    if (threadIdx.x == 0)
        atomic_add_global_u64(sm_hits + smid, 1);
    if (tid == 0 || (target_sm >= 0 && threadIdx.x == 0))
        atomic_add_global_u64(work_items, blockDim.x);
}

__global__ void l2_read_verify_kernel(const uint32_t *data, size_t words,
                                      uint64_t *errors, uint64_t *digest,
                                      uint64_t *sm_hits, uint64_t *work_items,
                                      int iterations, int target_sm,
                                      uint32_t salt) {
    uint32_t smid = read_smid();
    if (!selected_sm(target_sm, smid))
        return;

    uint32_t tid = blockIdx.x * blockDim.x + threadIdx.x;
    uint32_t state = mix32(tid ^ 0x31415926u);
    uint64_t local_errors = 0;
    uint64_t local_digest = 0;
    const uint32_t mask = static_cast<uint32_t>(words - 1);

    for (int i = 0; i < iterations; ++i) {
        state = state * 747796405u + 2891336453u;
        uint32_t idx = state & mask;
        uint32_t got = load_global_cg(data + idx);
        uint32_t expected = mix32(idx ^ salt);
        local_errors += got != expected;
        local_digest += static_cast<uint64_t>(got) * (i + 1u);
    }

    if (local_errors)
        atomic_add_global_u64(errors, local_errors);
    atomic_add_global_u64(digest, local_digest);
    if (threadIdx.x == 0)
        atomic_add_global_u64(sm_hits + smid, 1);
    if (tid == 0 || (target_sm >= 0 && threadIdx.x == 0))
        atomic_add_global_u64(work_items, blockDim.x);
}

__global__ void vram_transform_kernel(const uint32_t *src, uint32_t *dst,
                                      size_t words, uint64_t *errors,
                                      uint64_t *sm_hits, uint64_t *work_items,
                                      int target_sm, uint32_t salt) {
    uint32_t smid = read_smid();
    if (!selected_sm(target_sm, smid))
        return;

    size_t stride = static_cast<size_t>(gridDim.x) * blockDim.x;
    size_t idx = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t local_errors = 0;
    for (; idx < words; idx += stride) {
        uint32_t got = load_global_cg(src + idx);
        uint32_t expected = mix32(static_cast<uint32_t>(idx) ^ salt);
        local_errors += got != expected;
        store_global_wb(dst + idx, got ^ 0xd00df00du);
    }
    if (local_errors)
        atomic_add_global_u64(errors, local_errors);
    if (threadIdx.x == 0)
        atomic_add_global_u64(sm_hits + smid, 1);
    if (blockIdx.x == 0 && threadIdx.x == 0)
        atomic_add_global_u64(work_items, words);
}

__global__ void vram_verify_kernel(const uint32_t *dst, size_t words,
                                   uint64_t *errors, uint64_t *digest,
                                   int target_sm, uint32_t salt) {
    uint32_t smid = read_smid();
    if (!selected_sm(target_sm, smid))
        return;

    size_t stride = static_cast<size_t>(gridDim.x) * blockDim.x;
    size_t idx = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t local_errors = 0;
    uint64_t local_digest = 0;
    for (; idx < words; idx += stride) {
        uint32_t got = load_global_cg(dst + idx);
        uint32_t expected =
            mix32(static_cast<uint32_t>(idx) ^ salt) ^ 0xd00df00du;
        local_errors += got != expected;
        local_digest += static_cast<uint64_t>(got) *
                        (static_cast<uint32_t>(idx) | 1u);
    }
    if (local_errors)
        atomic_add_global_u64(errors, local_errors);
    atomic_add_global_u64(digest, local_digest);
}

__global__ void atomic_contention_kernel(uint64_t *bins,
                                         uint64_t *sm_hits,
                                         uint64_t *work_items, int iterations,
                                         int target_sm, uint32_t bin_mask) {
    uint32_t smid = read_smid();
    if (!selected_sm(target_sm, smid))
        return;

    uint32_t tid = blockIdx.x * blockDim.x + threadIdx.x;
    for (int i = 0; i < iterations; ++i) {
        uint32_t bin = (tid + static_cast<uint32_t>(i)) & bin_mask;
        atomic_add_global_u64(bins + bin, 1);
    }
    if (threadIdx.x == 0)
        atomic_add_global_u64(sm_hits + smid, 1);
    if (tid == 0 || (target_sm >= 0 && threadIdx.x == 0))
        atomic_add_global_u64(work_items, blockDim.x);
}

Affine32 compose(Affine32 lhs, Affine32 rhs) {
    // lhs(rhs(x)) modulo 2^32.
    return {static_cast<uint32_t>(lhs.mul * rhs.mul),
            static_cast<uint32_t>(lhs.mul * rhs.add + lhs.add)};
}

Affine32 affine_pow(uint32_t mul, uint32_t add, uint32_t exponent) {
    Affine32 result{1u, 0u};
    Affine32 base{mul, add};
    while (exponent) {
        if (exponent & 1u)
            result = compose(base, result);
        base = compose(base, base);
        exponent >>= 1u;
    }
    return result;
}

bool mode_enabled(const Options &opt, const char *name) {
    return opt.mode == "all" || opt.mode == name;
}

uint64_t monotonic_ns() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count());
}

size_t round_down_power_of_two(size_t value) {
    size_t result = 1;
    while (result <= value / 2)
        result *= 2;
    return result;
}

void clear_common(uint64_t *d_errors, uint64_t *d_digest,
                  uint64_t *d_sm_hits, uint64_t *d_work_items, int sm_count) {
    CUDA_OK(cudaMemset(d_errors, 0, sizeof(uint64_t)));
    CUDA_OK(cudaMemset(d_digest, 0, sizeof(uint64_t)));
    CUDA_OK(cudaMemset(d_sm_hits, 0, sizeof(uint64_t) * sm_count));
    CUDA_OK(cudaMemset(d_work_items, 0, sizeof(uint64_t)));
}

int covered_sms(uint64_t *d_sm_hits, int sm_count, std::vector<uint64_t> &hits) {
    hits.resize(sm_count);
    CUDA_OK(cudaMemcpy(hits.data(), d_sm_hits, sizeof(uint64_t) * sm_count,
                       cudaMemcpyDeviceToHost));
    return static_cast<int>(
        std::count_if(hits.begin(), hits.end(), [](uint64_t x) { return x; }));
}

void print_result(const char *mode, int pass, uint64_t rounds,
                  uint64_t errors, uint64_t digest, uint64_t work_items,
                  int sm_covered, int sm_expected, double elapsed,
                  double gib_processed) {
    std::printf(
        "RESULT mode=%s pass=%d rounds=%" PRIu64 " errors=%" PRIu64
        " digest=%016" PRIx64 " work_items=%" PRIu64
        " sm_covered=%d sm_expected=%d elapsed_s=%.6f gib=%.3f gib_s=%.3f\n",
        mode, pass, rounds, errors, digest, work_items, sm_covered, sm_expected,
        elapsed, gib_processed, elapsed > 0 ? gib_processed / elapsed : 0.0);
    std::fflush(stdout);
}

bool run_compute(const Options &opt, int sm_count, int blocks, int threads,
                 uint64_t *d_errors, uint64_t *d_digest,
                 uint64_t *d_sm_hits, uint64_t *d_work_items) {
    const size_t count = static_cast<size_t>(blocks) * threads;
    uint32_t *d_output = nullptr;
    CUDA_OK(cudaMalloc(&d_output, count * sizeof(uint32_t)));
    std::vector<uint32_t> output(count);
    const Affine32 transform =
        affine_pow(kLcgMul, kLcgAdd, opt.compute_iterations);
    uint64_t rounds = 0;
    uint64_t total_errors = 0;
    uint64_t total_digest = 0;
    uint64_t start = monotonic_ns();
    double elapsed = 0.0;
    std::vector<uint64_t> hits;
    int coverage = 0;

    do {
        clear_common(d_errors, d_digest, d_sm_hits, d_work_items, sm_count);
        compute_kernel<<<blocks, threads>>>(d_output, d_sm_hits, d_work_items,
                                            opt.compute_iterations,
                                            opt.target_sm);
        CUDA_OK(cudaGetLastError());
        CUDA_OK(cudaDeviceSynchronize());
        CUDA_OK(cudaMemcpy(output.data(), d_output, count * sizeof(uint32_t),
                           cudaMemcpyDeviceToHost));
        uint64_t errors = 0;
        uint64_t digest = 0;
        for (size_t tid = 0; tid < count; ++tid) {
            uint32_t seed = mix32(static_cast<uint32_t>(tid) ^ 0xa5a5f00du);
            uint32_t expected =
                static_cast<uint32_t>(transform.mul * seed + transform.add);
            if (opt.target_sm < 0) {
                errors += output[tid] != expected;
                digest += static_cast<uint64_t>(output[tid]) * (tid | 1u);
            }
        }
        total_errors += errors;
        total_digest ^= digest + rounds * 0x9e3779b97f4a7c15ull;
        coverage = std::max(coverage,
                            covered_sms(d_sm_hits, sm_count, hits));
        ++rounds;
        elapsed = (monotonic_ns() - start) / 1e9;
    } while (elapsed < opt.seconds && total_errors == 0);

    uint64_t work_items = 0;
    CUDA_OK(cudaMemcpy(&work_items, d_work_items, sizeof(work_items),
                       cudaMemcpyDeviceToHost));
    int expected_sms = opt.target_sm < 0 ? sm_count : 1;
    bool pass = total_errors == 0 && coverage >= expected_sms;
    double gib = static_cast<double>(count) * opt.compute_iterations * rounds *
                 sizeof(uint32_t) / (1024.0 * 1024.0 * 1024.0);
    print_result("compute", pass, rounds, total_errors, total_digest,
                 work_items, coverage, expected_sms, elapsed, gib);
    CUDA_OK(cudaFree(d_output));
    return pass;
}

bool run_l2(const Options &opt, int sm_count, int blocks, int threads,
            uint64_t *d_errors, uint64_t *d_digest, uint64_t *d_sm_hits,
            uint64_t *d_work_items) {
    size_t words = round_down_power_of_two(opt.l2_mib * 1024ull * 1024ull /
                                           sizeof(uint32_t));
    uint32_t *d_data = nullptr;
    CUDA_OK(cudaMalloc(&d_data, words * sizeof(uint32_t)));
    constexpr uint32_t salt = 0x13579bdfu;
    init_pattern_kernel<<<blocks, threads>>>(d_data, words, salt);
    CUDA_OK(cudaDeviceSynchronize());

    uint64_t rounds = 0;
    uint64_t start = monotonic_ns();
    double elapsed = 0.0;
    std::vector<uint64_t> hits;
    int coverage = 0;
    clear_common(d_errors, d_digest, d_sm_hits, d_work_items, sm_count);
    do {
        l2_read_verify_kernel<<<blocks, threads>>>(
            d_data, words, d_errors, d_digest, d_sm_hits, d_work_items,
            opt.l2_iterations, opt.target_sm, salt);
        CUDA_OK(cudaGetLastError());
        CUDA_OK(cudaDeviceSynchronize());
        ++rounds;
        elapsed = (monotonic_ns() - start) / 1e9;
    } while (elapsed < opt.seconds);

    uint64_t errors = 0, digest = 0, work_items = 0;
    CUDA_OK(cudaMemcpy(&errors, d_errors, sizeof(errors), cudaMemcpyDeviceToHost));
    CUDA_OK(cudaMemcpy(&digest, d_digest, sizeof(digest), cudaMemcpyDeviceToHost));
    CUDA_OK(cudaMemcpy(&work_items, d_work_items, sizeof(work_items),
                       cudaMemcpyDeviceToHost));
    coverage = covered_sms(d_sm_hits, sm_count, hits);
    int expected_sms = opt.target_sm < 0 ? sm_count : 1;
    bool pass = errors == 0 && coverage >= expected_sms;
    double gib = static_cast<double>(blocks) * threads * opt.l2_iterations *
                 rounds * sizeof(uint32_t) /
                 (1024.0 * 1024.0 * 1024.0);
    print_result("l2", pass, rounds, errors, digest, work_items, coverage,
                 expected_sms, elapsed, gib);
    CUDA_OK(cudaFree(d_data));
    return pass;
}

bool run_vram(const Options &opt, int sm_count, int blocks, int threads,
              uint64_t *d_errors, uint64_t *d_digest, uint64_t *d_sm_hits,
              uint64_t *d_work_items) {
    size_t words = opt.vram_mib * 1024ull * 1024ull / sizeof(uint32_t);
    uint32_t *d_src = nullptr, *d_dst = nullptr;
    CUDA_OK(cudaMalloc(&d_src, words * sizeof(uint32_t)));
    CUDA_OK(cudaMalloc(&d_dst, words * sizeof(uint32_t)));
    constexpr uint32_t salt = 0x2468ace0u;
    init_pattern_kernel<<<blocks, threads>>>(d_src, words, salt);
    CUDA_OK(cudaDeviceSynchronize());

    uint64_t rounds = 0;
    uint64_t start = monotonic_ns();
    double elapsed = 0.0;
    clear_common(d_errors, d_digest, d_sm_hits, d_work_items, sm_count);
    do {
        vram_transform_kernel<<<blocks, threads>>>(
            d_src, d_dst, words, d_errors, d_sm_hits, d_work_items,
            opt.target_sm, salt);
        CUDA_OK(cudaGetLastError());
        vram_verify_kernel<<<blocks, threads>>>(d_dst, words, d_errors,
                                                d_digest, opt.target_sm, salt);
        CUDA_OK(cudaGetLastError());
        CUDA_OK(cudaDeviceSynchronize());
        ++rounds;
        elapsed = (monotonic_ns() - start) / 1e9;
    } while (elapsed < opt.seconds);

    uint64_t errors = 0, digest = 0, work_items = 0;
    CUDA_OK(cudaMemcpy(&errors, d_errors, sizeof(errors), cudaMemcpyDeviceToHost));
    CUDA_OK(cudaMemcpy(&digest, d_digest, sizeof(digest), cudaMemcpyDeviceToHost));
    CUDA_OK(cudaMemcpy(&work_items, d_work_items, sizeof(work_items),
                       cudaMemcpyDeviceToHost));
    std::vector<uint64_t> hits;
    int coverage = covered_sms(d_sm_hits, sm_count, hits);
    int expected_sms = opt.target_sm < 0 ? sm_count : 1;
    bool pass = errors == 0 && coverage >= expected_sms;
    double gib = static_cast<double>(words) * sizeof(uint32_t) * 3.0 * rounds /
                 (1024.0 * 1024.0 * 1024.0);
    print_result("vram", pass, rounds, errors, digest, work_items, coverage,
                 expected_sms, elapsed, gib);
    CUDA_OK(cudaFree(d_dst));
    CUDA_OK(cudaFree(d_src));
    return pass;
}

bool run_atomic(const Options &opt, int sm_count, int blocks, int threads,
                uint64_t *d_errors, uint64_t *d_digest,
                uint64_t *d_sm_hits, uint64_t *d_work_items) {
    constexpr uint32_t bin_count = 1024;
    uint64_t *d_bins = nullptr;
    CUDA_OK(cudaMalloc(&d_bins, bin_count * sizeof(uint64_t)));
    std::vector<uint64_t> bins(bin_count);
    uint64_t rounds = 0;
    uint64_t total_errors = 0;
    uint64_t total_digest = 0;
    uint64_t start = monotonic_ns();
    double elapsed = 0.0;
    std::vector<uint64_t> hits;
    int coverage = 0;

    do {
        CUDA_OK(cudaMemset(d_bins, 0, bin_count * sizeof(uint64_t)));
        clear_common(d_errors, d_digest, d_sm_hits, d_work_items, sm_count);
        atomic_contention_kernel<<<blocks, threads>>>(
            d_bins, d_sm_hits, d_work_items, opt.atomic_iterations,
            opt.target_sm, bin_count - 1);
        CUDA_OK(cudaGetLastError());
        CUDA_OK(cudaDeviceSynchronize());
        CUDA_OK(cudaMemcpy(bins.data(), d_bins,
                           bin_count * sizeof(uint64_t),
                           cudaMemcpyDeviceToHost));
        uint64_t total = 0;
        for (size_t i = 0; i < bins.size(); ++i) {
            total += bins[i];
            total_digest ^= bins[i] + i * 0x9e3779b97f4a7c15ull;
        }
        if (opt.target_sm < 0) {
            uint64_t expected =
                static_cast<uint64_t>(blocks) * threads *
                opt.atomic_iterations;
            total_errors += total != expected;
        } else {
            total_errors += total == 0;
        }
        coverage = std::max(coverage,
                            covered_sms(d_sm_hits, sm_count, hits));
        ++rounds;
        elapsed = (monotonic_ns() - start) / 1e9;
    } while (elapsed < opt.seconds && total_errors == 0);

    uint64_t work_items = 0;
    CUDA_OK(cudaMemcpy(&work_items, d_work_items, sizeof(work_items),
                       cudaMemcpyDeviceToHost));
    int expected_sms = opt.target_sm < 0 ? sm_count : 1;
    bool pass = total_errors == 0 && coverage >= expected_sms;
    double gib = static_cast<double>(blocks) * threads *
                 opt.atomic_iterations * rounds * sizeof(uint64_t) /
                 (1024.0 * 1024.0 * 1024.0);
    print_result("atomic", pass, rounds, total_errors, total_digest,
                 work_items, coverage, expected_sms, elapsed, gib);
    CUDA_OK(cudaFree(d_bins));
    return pass;
}

void usage(const char *argv0) {
    std::fprintf(
        stderr,
        "usage: %s [--mode all|compute|l2|vram|atomic] [--seconds N] "
        "[--l2-mib N] [--vram-mib N] [--target-sm N|-1]\n",
        argv0);
}

Options parse_options(int argc, char **argv) {
    Options opt;
    for (int i = 1; i < argc; ++i) {
        auto need = [&](const char *name) -> const char * {
            if (++i >= argc) {
                std::fprintf(stderr, "missing value for %s\n", name);
                usage(argv[0]);
                std::exit(64);
            }
            return argv[i];
        };
        if (!std::strcmp(argv[i], "--mode"))
            opt.mode = need("--mode");
        else if (!std::strcmp(argv[i], "--seconds"))
            opt.seconds = std::strtod(need("--seconds"), nullptr);
        else if (!std::strcmp(argv[i], "--l2-mib"))
            opt.l2_mib = std::strtoull(need("--l2-mib"), nullptr, 0);
        else if (!std::strcmp(argv[i], "--vram-mib"))
            opt.vram_mib = std::strtoull(need("--vram-mib"), nullptr, 0);
        else if (!std::strcmp(argv[i], "--target-sm"))
            opt.target_sm = std::strtol(need("--target-sm"), nullptr, 0);
        else if (!std::strcmp(argv[i], "--help")) {
            usage(argv[0]);
            std::exit(0);
        } else {
            std::fprintf(stderr, "unknown option: %s\n", argv[i]);
            usage(argv[0]);
            std::exit(64);
        }
    }
    if (opt.mode != "all" && opt.mode != "compute" && opt.mode != "l2" &&
        opt.mode != "vram" && opt.mode != "atomic") {
        std::fprintf(stderr, "invalid mode: %s\n", opt.mode.c_str());
        std::exit(64);
    }
    if (!(opt.seconds > 0.0) || opt.seconds > 3600.0 || opt.l2_mib < 1 ||
        opt.vram_mib < 16) {
        std::fprintf(stderr, "invalid numeric option\n");
        std::exit(64);
    }
    return opt;
}

} // namespace

int main(int argc, char **argv) {
    Options opt = parse_options(argc, argv);
    CUDA_OK(cudaSetDevice(0));
    cudaDeviceProp prop{};
    CUDA_OK(cudaGetDeviceProperties(&prop, 0));
    if (opt.target_sm >= prop.multiProcessorCount) {
        std::fprintf(stderr, "target SM %d outside 0..%d\n", opt.target_sm,
                     prop.multiProcessorCount - 1);
        return 64;
    }

    const int threads = 256;
    const int blocks = prop.multiProcessorCount * 4;
    std::printf(
        "BEGIN gpu=%s cc=%d.%d sms=%d blocks=%d threads=%d mode=%s "
        "seconds=%.3f target_sm=%d l2_mib=%zu vram_mib=%zu\n",
        prop.name, prop.major, prop.minor, prop.multiProcessorCount, blocks,
        threads, opt.mode.c_str(), opt.seconds, opt.target_sm, opt.l2_mib,
        opt.vram_mib);
    std::fflush(stdout);

    uint64_t *d_errors = nullptr, *d_digest = nullptr, *d_sm_hits = nullptr,
             *d_work_items = nullptr;
    CUDA_OK(cudaMalloc(&d_errors, sizeof(uint64_t)));
    CUDA_OK(cudaMalloc(&d_digest, sizeof(uint64_t)));
    CUDA_OK(cudaMalloc(&d_sm_hits,
                       sizeof(uint64_t) * prop.multiProcessorCount));
    CUDA_OK(cudaMalloc(&d_work_items, sizeof(uint64_t)));

    bool pass = true;
    if (mode_enabled(opt, "compute"))
        pass &= run_compute(opt, prop.multiProcessorCount, blocks, threads,
                            d_errors, d_digest, d_sm_hits, d_work_items);
    if (mode_enabled(opt, "l2"))
        pass &= run_l2(opt, prop.multiProcessorCount, blocks, threads, d_errors,
                       d_digest, d_sm_hits, d_work_items);
    if (mode_enabled(opt, "vram"))
        pass &= run_vram(opt, prop.multiProcessorCount, blocks, threads,
                         d_errors, d_digest, d_sm_hits, d_work_items);
    if (mode_enabled(opt, "atomic"))
        pass &= run_atomic(opt, prop.multiProcessorCount, blocks, threads,
                           d_errors, d_digest, d_sm_hits, d_work_items);

    CUDA_OK(cudaFree(d_work_items));
    CUDA_OK(cudaFree(d_sm_hits));
    CUDA_OK(cudaFree(d_digest));
    CUDA_OK(cudaFree(d_errors));
    CUDA_OK(cudaDeviceReset());
    std::printf("END pass=%d\n", pass ? 1 : 0);
    return pass ? 0 : 1;
}
