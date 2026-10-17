package activity

// The process tracker survives replacement Server instances during reload.
var processTracker = New()

func Process() *Tracker { return processTracker }

// Invalidate latches unknown permanently. It never interrupts serving work.
func (t *Tracker) Invalidate() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.latchLocked()
}
