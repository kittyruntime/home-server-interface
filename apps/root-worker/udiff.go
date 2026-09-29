package main

import (
	"fmt"
	"strings"
)

// unifiedDiff renders the change from before to after as a unified diff with
// two lines of context. Config files are small, so a plain LCS is enough.
func unifiedDiff(path, before, after string) string {
	if before == after {
		return ""
	}
	a, b := splitLines(before), splitLines(after)
	// LCS table.
	lcs := make([][]int, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	type op struct {
		kind byte // ' ', '-', '+'
		text string
		ai   int // line number in a (1-based) for ' ' and '-'
		bi   int // line number in b (1-based) for ' ' and '+'
	}
	var ops []op
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		switch {
		case i < len(a) && j < len(b) && a[i] == b[j]:
			ops = append(ops, op{' ', a[i], i + 1, j + 1})
			i++
			j++
		case i < len(a) && (j == len(b) || lcs[i+1][j] >= lcs[i][j+1]):
			ops = append(ops, op{'-', a[i], i + 1, j})
			i++
		default:
			ops = append(ops, op{'+', b[j], i, j + 1})
			j++
		}
	}
	const ctx = 2
	var out strings.Builder
	name := strings.TrimPrefix(path, "/")
	fmt.Fprintf(&out, "--- a/%s\n+++ b/%s\n", name, name)
	for k := 0; k < len(ops); {
		if ops[k].kind == ' ' {
			k++
			continue
		}
		// Hunk: from ctx lines before this change to ctx lines after the last
		// change that is within 2*ctx of the previous one.
		start := k - ctx
		if start < 0 {
			start = 0
		}
		end := k
		for end < len(ops) {
			if ops[end].kind != ' ' {
				end++
				continue
			}
			run := end
			for run < len(ops) && ops[run].kind == ' ' {
				run++
			}
			if run < len(ops) && run-end <= 2*ctx {
				end = run
				continue
			}
			end += ctx
			if end > len(ops) {
				end = len(ops)
			}
			break
		}
		aStart, bStart, aLen, bLen := 0, 0, 0, 0
		for _, o := range ops[start:end] {
			if o.kind != '+' {
				if aStart == 0 {
					aStart = o.ai
				}
				aLen++
			}
			if o.kind != '-' {
				if bStart == 0 {
					bStart = o.bi
				}
				bLen++
			}
		}
		fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@\n", aStart, aLen, bStart, bLen)
		for _, o := range ops[start:end] {
			out.WriteByte(o.kind)
			out.WriteString(o.text)
			out.WriteByte('\n')
		}
		k = end
	}
	return out.String()
}

func splitLines(s string) []string {
	s = strings.TrimSuffix(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}
