---
'devalue': patch
---

perf: `stringify` skips per-character escaping for strings with nothing to escape, classifies arrays and plain objects without `Object.prototype.toString`, and formats the error path only when a `DevalueError` is raised
