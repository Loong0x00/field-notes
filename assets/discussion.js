(() => {
  "use strict";

  const configuredApi = document.body.dataset.commentsApi?.trim();
  const apiBase = configuredApi ? configuredApi.replace(/\/$/, "") : window.location.origin;

  class APIError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers,
      credentials: "include",
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      throw new APIError(
        payload?.error?.code || "request_failed",
        payload?.error?.message || `请求失败（${response.status}）`,
        response.status,
      );
    }
    return payload;
  }

  function setNotice(element, message, kind = "error") {
    if (!element) return;
    element.textContent = message || "";
    element.dataset.kind = kind;
    element.hidden = !message;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, handler) {
    const node = el("button", "", text);
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  }

  function formatTime(value) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  }

  let configPromise;
  function getConfig() {
    configPromise ||= api("/v1/config");
    return configPromise;
  }

  let turnstilePromise;
  function loadTurnstile() {
    turnstilePromise ||= new Promise((resolve, reject) => {
      if (window.turnstile) return resolve(window.turnstile);
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(window.turnstile);
      script.onerror = () => reject(new Error("无法加载人机验证"));
      document.head.append(script);
    });
    return turnstilePromise;
  }

  const widgets = new WeakMap();
  async function ensureTurnstile(container) {
    if (!container) return null;
    const config = await getConfig();
    if (!config.turnstile_site_key) return null;
    container.hidden = false;
    if (widgets.has(container)) return widgets.get(container);
    const turnstile = await loadTurnstile();
    const id = turnstile.render(container, {
      sitekey: config.turnstile_site_key,
      theme: "dark",
      size: "flexible",
    });
    widgets.set(container, id);
    return id;
  }

  function turnstileToken(container) {
    const id = widgets.get(container);
    return id === undefined || id === null ? "" : window.turnstile.getResponse(id);
  }

  function resetTurnstile(container) {
    const id = widgets.get(container);
    if (id !== undefined && id !== null && window.turnstile) window.turnstile.reset(id);
  }

  async function initAccountPage(root) {
    const current = root.querySelector("[data-account-current]");
    const forms = root.querySelector("[data-account-forms]");
    const notice = root.querySelector("[data-account-notice]");
    const recovery = root.querySelector("[data-recovery-result]");
    const recoveryCode = root.querySelector("[data-recovery-code]");
    const registerTurnstile = root.querySelector("[data-turnstile-register]");
    const recoverTurnstile = root.querySelector("[data-turnstile-recover]");
    const loginTurnstile = root.querySelector("[data-turnstile-login]");
    let me = null;

    function showRecovery(code) {
      recoveryCode.textContent = code;
      recovery.hidden = false;
      recovery.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function renderCurrent() {
      current.replaceChildren();
      if (!me) {
        current.textContent = "尚未登录。注册与登录都只使用用户名和密码。";
        forms.hidden = false;
        return;
      }
      current.append(`已登录为 ${me.username}`);
      if (me.role === "admin") current.append("（站点管理员）");
      current.append(button("退出登录", async () => {
        try {
          await api("/v1/auth/logout", { method: "POST" });
          me = null;
          recovery.hidden = true;
          renderCurrent();
        } catch (error) {
          setNotice(notice, error.message);
        }
      }));
      forms.hidden = true;
    }

    try {
      const [session] = await Promise.all([
        api("/v1/auth/session"),
        ensureTurnstile(registerTurnstile),
        ensureTurnstile(recoverTurnstile),
      ]);
      me = session.user;
      renderCurrent();
    } catch (error) {
      current.textContent = "讨论服务暂时不可用。文章阅读不受影响。";
      setNotice(notice, error.message);
      return;
    }

    root.querySelector("[data-login-form]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector("button[type=submit]");
      submit.disabled = true;
      setNotice(notice, "");
      try {
        const data = new FormData(form);
        const result = await api("/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({
            username: data.get("username"),
            password: data.get("password"),
            turnstile_token: turnstileToken(loginTurnstile),
          }),
        });
        me = result.user;
        renderCurrent();
      } catch (error) {
        if (error.code === "turnstile_required") await ensureTurnstile(loginTurnstile);
        resetTurnstile(loginTurnstile);
        setNotice(notice, error.message);
      } finally {
        submit.disabled = false;
      }
    });

    root.querySelector("[data-register-form]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector("button[type=submit]");
      const data = new FormData(form);
      if (data.get("password") !== data.get("password_repeat")) {
        setNotice(notice, "两次输入的密码不一致。");
        return;
      }
      submit.disabled = true;
      setNotice(notice, "");
      try {
        const result = await api("/v1/auth/register", {
          method: "POST",
          body: JSON.stringify({
            username: data.get("username"),
            password: data.get("password"),
            turnstile_token: turnstileToken(registerTurnstile),
          }),
        });
        me = result.user;
        renderCurrent();
        showRecovery(result.recovery_code);
        form.reset();
      } catch (error) {
        resetTurnstile(registerTurnstile);
        setNotice(notice, error.message);
      } finally {
        submit.disabled = false;
      }
    });

    root.querySelector("[data-recover-form]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector("button[type=submit]");
      const data = new FormData(form);
      submit.disabled = true;
      setNotice(notice, "");
      try {
        const result = await api("/v1/auth/recover", {
          method: "POST",
          body: JSON.stringify({
            username: data.get("username"),
            recovery_code: data.get("recovery_code"),
            password: data.get("password"),
            turnstile_token: turnstileToken(recoverTurnstile),
          }),
        });
        me = result.user;
        renderCurrent();
        showRecovery(result.recovery_code);
        form.reset();
      } catch (error) {
        resetTurnstile(recoverTurnstile);
        setNotice(notice, error.message);
      } finally {
        submit.disabled = false;
      }
    });

    root.querySelector("[data-copy-recovery]").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(recoveryCode.textContent);
        setNotice(notice, "恢复码已复制。请保存到密码管理器。", "ok");
      } catch {
        setNotice(notice, "复制失败，请手动保存恢复码。");
      }
    });
  }

  function composer({ initialBody = "", attachments = [], label = "发表", onSubmit, onCancel }) {
    const form = el("form", "comment-form");
    const textarea = el("textarea");
    textarea.name = "body";
    textarea.maxLength = 8000;
    textarea.placeholder = "纯文本；不会解析 HTML。正文可以为空，但至少需要一张图片。";
    textarea.value = initialBody;
    form.append(textarea);

    const kept = new Set(attachments.map((item) => item.id));
    if (attachments.length) {
      const existing = el("div", "upload-list");
      existing.append("保留已有图片：");
      attachments.forEach((item) => {
        const row = el("label", "attachment-keep");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = true;
        checkbox.addEventListener("change", () => checkbox.checked ? kept.add(item.id) : kept.delete(item.id));
        row.append(checkbox, document.createTextNode(`${item.width}×${item.height} / ${Math.ceil(item.size / 1024)} KiB`));
        existing.append(row);
      });
      form.append(existing);
    }

    const file = document.createElement("input");
    file.type = "file";
    file.name = "images";
    file.accept = "image/jpeg,image/png,image/webp";
    file.multiple = true;
    form.append(file);
    form.append(el("p", "comment-form-note", "最多 4 张；单张不超过 8 MiB；JPEG、PNG 或 WebP。"));

    const actions = el("div", "comment-form-actions");
    const submit = el("button", "", label);
    submit.type = "submit";
    actions.append(submit);
    if (onCancel) actions.append(button("取消", onCancel));
    form.append(actions);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await onSubmit({
          body: textarea.value,
          files: Array.from(file.files || []),
          attachmentIds: Array.from(kept),
        });
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  async function initDiscussion(root) {
    const articleKey = root.dataset.articleKey;
    const identity = root.querySelector("[data-discussion-identity]");
    const notice = root.querySelector("[data-discussion-notice]");
    const rootComposer = root.querySelector("[data-root-composer]");
    const tree = root.querySelector("[data-comment-tree]");
    let me = null;
    let comments = [];

    async function uploadFiles(files) {
      if (files.length > 4) throw new APIError("too_many_images", "每条评论最多 4 张图片。", 400);
      const ids = [];
      for (const image of files) {
        const data = new FormData();
        data.append("file", image);
        const result = await api("/v1/uploads", { method: "POST", body: data });
        ids.push(result.attachment.id);
      }
      return ids;
    }

    async function reload() {
      const result = await api(`/v1/articles/${encodeURIComponent(articleKey)}/comments`);
      comments = result.comments;
      renderTree();
    }

    function renderIdentity() {
      identity.replaceChildren();
      if (!me) {
        const link = el("a", "", "登录或注册后参与讨论");
        link.href = "/account/";
        identity.append(link);
        rootComposer.hidden = true;
        return;
      }
      identity.append(`以 ${me.username} 登录`);
      identity.append(button("退出", async () => {
        try {
          await api("/v1/auth/logout", { method: "POST" });
          me = null;
          renderIdentity();
          renderTree();
        } catch (error) {
          setNotice(notice, error.message);
        }
      }));
      rootComposer.hidden = false;
      rootComposer.replaceChildren(composer({
        onSubmit: async ({ body, files }) => {
          setNotice(notice, "");
          try {
            const attachmentIds = await uploadFiles(files);
            await api(`/v1/articles/${encodeURIComponent(articleKey)}/comments`, {
              method: "POST",
              body: JSON.stringify({ body, parent_id: null, attachment_ids: attachmentIds }),
            });
            rootComposer.querySelector("form").reset();
            await reload();
          } catch (error) {
            setNotice(notice, error.message);
          }
        },
      }));
    }

    function attachmentGrid(items) {
      const grid = el("div", "comment-attachments");
      items.forEach((item, index) => {
        const link = document.createElement("a");
        link.href = `${apiBase}${item.url}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const image = document.createElement("img");
        image.src = link.href;
        image.alt = `评论图片 ${index + 1}`;
        image.loading = "lazy";
        image.decoding = "async";
        image.width = item.width;
        image.height = item.height;
        link.append(image);
        grid.append(link);
      });
      return grid;
    }

    function openReply(container, parent) {
      const old = container.querySelector(":scope > .inline-composer");
      if (old) old.remove();
      const holder = el("div", "discussion-compose inline-composer");
      holder.append(composer({
        label: "回复",
        onCancel: () => holder.remove(),
        onSubmit: async ({ body, files }) => {
          setNotice(notice, "");
          try {
            const attachmentIds = await uploadFiles(files);
            await api(`/v1/articles/${encodeURIComponent(articleKey)}/comments`, {
              method: "POST",
              body: JSON.stringify({ body, parent_id: parent.id, attachment_ids: attachmentIds }),
            });
            await reload();
          } catch (error) {
            setNotice(notice, error.message);
          }
        },
      }));
      container.append(holder);
      holder.querySelector("textarea").focus();
    }

    function openEdit(container, comment) {
      const old = container.querySelector(":scope > .inline-composer");
      if (old) old.remove();
      const holder = el("div", "discussion-compose inline-composer");
      holder.append(composer({
        initialBody: comment.body,
        attachments: comment.attachments,
        label: "保存修改",
        onCancel: () => holder.remove(),
        onSubmit: async ({ body, files, attachmentIds }) => {
          setNotice(notice, "");
          try {
            const uploaded = await uploadFiles(files);
            await api(`/v1/comments/${comment.id}`, {
              method: "PATCH",
              body: JSON.stringify({ body, attachment_ids: [...attachmentIds, ...uploaded] }),
            });
            await reload();
          } catch (error) {
            setNotice(notice, error.message);
          }
        },
      }));
      container.append(holder);
      holder.querySelector("textarea").focus();
    }

    function commentNode(comment, depth) {
      const branch = el("div", "comment-branch");
      branch.style.setProperty("--depth", Math.min(depth, 7));
      const card = el("article", "comment-card");
      card.id = `comment-${comment.id}`;

      const meta = el("div", "comment-meta");
      meta.append(el("span", "comment-author", comment.author.username));
      if (comment.author.role === "admin") meta.append(el("span", "comment-role", "作者"));
      meta.append(el("time", "", formatTime(comment.created_at)));
      if (comment.edited_at) meta.append(el("span", "", "已编辑"));
      if (comment.hidden) meta.append(el("span", "comment-role", "已隐藏"));
      card.append(meta);

      if (comment.deleted || (comment.hidden && me?.role !== "admin")) {
        card.append(el("p", "comment-body comment-tombstone", comment.deleted ? "这条内容已由作者删除。" : "这条内容已被站点管理员隐藏。"));
      } else {
        if (comment.body) card.append(el("p", "comment-body", comment.body));
        if (comment.attachments.length) card.append(attachmentGrid(comment.attachments));
      }

      const actions = el("div", "comment-actions");
      if (me && !comment.deleted) actions.append(button("回复", () => openReply(card, comment)));
      if (me && me.id === comment.author.id && !comment.deleted && !comment.hidden) {
        actions.append(button("编辑", () => openEdit(card, comment)));
        actions.append(button("删除", async () => {
          if (!window.confirm("删除正文和图片？已有回复会被保留。")) return;
          try {
            await api(`/v1/comments/${comment.id}`, { method: "DELETE" });
            await reload();
          } catch (error) {
            setNotice(notice, error.message);
          }
        }));
      }
      if (me?.role === "admin" && !comment.deleted) {
        actions.append(button(comment.hidden ? "恢复显示" : "隐藏", async () => {
          try {
            await api(`/v1/mod/comments/${comment.id}`, {
              method: "POST",
              body: JSON.stringify({ action: comment.hidden ? "restore" : "hide" }),
            });
            await reload();
          } catch (error) {
            setNotice(notice, error.message);
          }
        }));
        if (comment.author.id !== me.id) actions.append(button("封禁账户", async () => {
          if (!window.confirm(`封禁 ${comment.author.username}？`)) return;
          try {
            await api(`/v1/mod/users/${comment.author.id}`, {
              method: "POST",
              body: JSON.stringify({ action: "ban" }),
            });
            setNotice(notice, "账户已封禁。", "ok");
          } catch (error) {
            setNotice(notice, error.message);
          }
        }));
      }
      if (actions.childNodes.length) card.append(actions);
      branch.append(card);
      return branch;
    }

    function renderTree() {
      tree.replaceChildren();
      if (!comments.length) {
        tree.append(el("p", "comment-empty", "还没有讨论。"));
        return;
      }
      const children = new Map();
      comments.forEach((comment) => {
        const key = comment.parent_id || "root";
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(comment);
      });
      const seen = new Set();
      const append = (parent, key, depth) => {
        for (const comment of children.get(key) || []) {
          if (seen.has(comment.id)) continue;
          seen.add(comment.id);
          const node = commentNode(comment, depth);
          parent.append(node);
          append(node, comment.id, depth + 1);
        }
      };
      append(tree, "root", 0);
      for (const comment of comments) {
        if (!seen.has(comment.id)) append(tree, comment.parent_id || "root", 0);
      }
    }

    try {
      const [session, result] = await Promise.all([
        api("/v1/auth/session"),
        api(`/v1/articles/${encodeURIComponent(articleKey)}/comments`),
      ]);
      me = session.user;
      comments = result.comments;
      renderIdentity();
      renderTree();
    } catch (error) {
      identity.textContent = "讨论服务暂时不可用";
      tree.replaceChildren();
      setNotice(notice, `${error.message} 文章阅读不受影响。`);
    }
  }

  document.querySelectorAll("[data-auth-page]").forEach(initAccountPage);
  document.querySelectorAll("[data-discussion]").forEach(initDiscussion);
})();
