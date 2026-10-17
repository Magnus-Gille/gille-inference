package activity

import "net/http"

// Only these two pinned upstream handlers are audited as a constant HTTP 200
// with no routing, body read, scheduling or lifecycle operation. All other
// public requests remain counted, including rejected and administrative ones.
func PublicRequest(r *http.Request) *Handle {
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
		(r.URL.Path == "/health" || r.URL.Path == "/wol-health") {
		return nil
	}
	return Process().Begin(Queued)
}
