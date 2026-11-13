# Updating with live sessions

The updater activates the candidate **HTTP API** after HTTP 200 and an exact
version match. It does not wait for existing WebSockets or voice sessions to end
before that activation. `active_draining` means the new API is active while the
previous gateway/media process still preserves sessions. It is a successful API
activation, not a claim that in-memory media has moved between processes.

While that process exists, the new gateway proxies new sessions to it too. This
keeps all peers in one media/router and gateway namespace. API notifications are
relayed over a private SQLite control bus; presence and voice snapshots and
moderation commands use the same control channel. The old HTTP listener forwards
requests on existing keepalive connections to the new API. It closes each HTTP
connection after its response, without closing any upgraded WebSocket.

Retirement is separate. The active API must confirm there are no old gateways,
voice participants, pending HTTP requests, TCP clients or connecting gateway
proxies. It then pauses new gateway assignment and obtains an acknowledgement
from the old listener before using its own gateway. Only that acknowledgement
allows the updater to stop the old container. Another update/configuration swap
is blocked while the old slot still belongs to live sessions. Gateway/media
configuration changes take effect when that component is replaced; the dashboard
reports its version separately.

The first transition supports the exact published alpha.2 global-account image
`sha256:d6b4fe304cba5cebfa26ea298d75f69bf848fdc4785f14e7e633d75638365346`.
A content-addressed compatibility bundle from the validated candidate is loaded
through a private, PID-verified Inspector connection; the helper closes only an
Inspector it opened itself. The module verifies that it sees the original live
gateway namespace before changing HTTP handling. Later compatible images expose
a host-only preparation endpoint. Unsupported runtimes fail without stopping
the serving process. Local-account mode is currently unsupported by this handoff
because its direct-call and social state would also need coordination.

The proxy must stay running during this first transition. Neither `compose down`
nor restarting the proxy preserves existing sockets. The updater touches only
the candidate and, after confirmed retirement, the unused old slot.

If candidate health fails before promotion, activation is refused. Once API
ownership has changed, a health failure preserves both containers and reports an
error; it does not blindly switch the proxy to an old HTTP listener that still
forwards requests. An updater restart with an incomplete handoff similarly
reports `handoff_recovery` and preserves both processes. This requires operator
recovery; do not stop either process to clear the warning.

Isolated validation used the exact alpha.2 image with fake users and a separate
SQLite database. An existing gateway and voice session stayed open through
bootstrap and HTTP ownership change; a second gateway through the new API joined
the same voice namespace. Both received the same message from the new API.
Retirement was refused while sessions existed and acknowledged after both
clients closed normally. External host-admin access remained forbidden and the
private Inspector was closed afterward. This checks voice session continuity;
it does not measure live microphone/audio quality.
