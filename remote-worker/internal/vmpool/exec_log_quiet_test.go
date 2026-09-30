package vmpool

// The test binary runs thousands of Execs, and the always-on exec audit line (runner.go's execLog)
// wrote one line for each. That volume alone starved TestWaitForUnixSocketBackoffGrowsAndIsCapped,
// a wall-clock probe count, below its floor on roughly half of full-module runs (and never with the
// line silenced). So tests default it to a no-op, the way phaseLog is nil unless a test opts in; the
// tests that assert on the line capture it themselves.
func init() { execLog = func(string, ...any) {} }
