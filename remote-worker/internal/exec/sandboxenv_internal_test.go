package exec

import (
	"os"
	"regexp"
	"sort"
	"testing"
)

// Drift guard (PR #350 review): workerSettings is a hand-kept copy of what cmd/worker/main.go
// reads. A setting added there and not here would reach every command by default, which is how
// RELAY_TLS and WORKER_MAX_CONCURRENT were missed once already. Every name the worker reads must be
// excluded by commandEnv.
func TestEveryWorkerSettingIsExcluded(t *testing.T) {
	src, err := os.ReadFile("../../cmd/worker/main.go")
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`\b(?:env|envInt|envBool|os\.Getenv|os\.LookupEnv)\("([A-Z0-9_]+)"`)
	var read []string
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		read = append(read, m[1])
	}
	sort.Strings(read)
	// Sensitivity control: the regex must find the settings main.go is known to read, or a
	// refactor of the helpers would leave this test checking nothing.
	if len(read) < 7 {
		t.Fatalf("found only %v in cmd/worker/main.go: the pattern no longer matches how it reads its settings", read)
	}
	for _, name := range read {
		if got := commandEnv([]string{name + "=v"}); len(got) != 0 {
			t.Errorf("cmd/worker/main.go reads %s, but commandEnv passes it to commands", name)
		}
	}
}
