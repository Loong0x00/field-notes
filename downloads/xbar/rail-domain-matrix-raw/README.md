# Rail-by-domain raw captures

These are the 32 STATUS-bank CSVs and eight application logs behind
`GB202_RAIL_DOMAIN_ADOPTION_MATRIX_20260816.md`.

For each request `{gpc,xbar,sys,nvd}-rail{0,1}`, the four CSVs ending in
`-{gpc,xbar,sys,nvd}.csv` contain the complete 127-point observations. The
matching `.log` records the request, readback, adoption summary, and restore.

The tested perturbation was +1000 uV. These files establish logical STATUS
adoption only; they are not a reusable voltage profile and do not establish a
safe physical rail range.
