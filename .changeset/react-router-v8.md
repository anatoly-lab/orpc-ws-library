---
"@orpc-ws/oidc-react": minor
---

The `./react-router` sub-path's optional peer dependency is now
`react-router` (range `>=7.0.0`) instead of the removed `react-router-dom`.
React Router v7 merged the former `react-router-dom` DOM bindings into the
main `react-router` package; `react-router-dom` is a deprecated re-export
shim that v8 removes. The `OidcCallback` component now imports `useNavigate`
from `react-router`. Consumers of the sub-path should depend on
`react-router` (v7 or v8) rather than `react-router-dom`; the main entry is
unaffected (it has no router dependency).

Also raises the published cores' `engines.node` 22-line floor from
`>=22.12.0` to `>=22.22.0` (the range is now `^20.19.0 || >=22.22.0`),
matching react-router v8's `engines.node` requirement. Node 20.19+ support
is retained.
