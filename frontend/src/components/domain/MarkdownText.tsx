"use client";

import { useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

/**
 * Renders agent / assistant markdown text. Supports:
 *   - GitHub-flavored markdown (tables, task lists, strikethrough)
 *   - Syntax-highlighted fenced code blocks (one click to copy)
 *   - Inline code, lists, headers, links
 *   - Streaming-safe rendering — unclosed code fences are virtually closed
 *     while text is still arriving so the buffer renders as a real code
 *     block instead of leaking the rest of the document into "code" mode.
 *
 * Styling is kept inline (CSS-in-JS via style props) so the component stays
 * portable without depending on a separate stylesheet. Code blocks inherit
 * the dark Prism theme.
 */
export function MarkdownText({ text }: { text: string }) {
  const safe = balanceStreamingMarkdown(text);
  return (
    <div className="dda-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children, ...rest } = props as ComponentPropsWithoutRef<"code"> & {
              inline?: boolean;
            };
            const match = /language-(\w+)/.exec(className ?? "");
            const isBlock = !!match || (typeof children === "string" && children.includes("\n"));
            if (!isBlock) {
              return (
                <code
                  className="mono"
                  style={{
                    background: "var(--surface-2)",
                    padding: "1px 6px",
                    borderRadius: 4,
                    fontSize: "0.9em",
                    border: "1px solid var(--border-soft)",
                  }}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            const codeStr = String(children).replace(/\n$/, "");
            const lang = match?.[1] ?? "text";
            return <CodeBlock code={codeStr} lang={lang} />;
          },
          p({ children }) {
            return <p style={{ margin: "0.5em 0", lineHeight: 1.6 }}>{children}</p>;
          },
          ul({ children }) {
            return (
              <ul style={{ margin: "0.5em 0", paddingLeft: 22, lineHeight: 1.6 }}>{children}</ul>
            );
          },
          ol({ children }) {
            return (
              <ol style={{ margin: "0.5em 0", paddingLeft: 22, lineHeight: 1.6 }}>{children}</ol>
            );
          },
          li({ children }) {
            return <li style={{ margin: "0.2em 0" }}>{children}</li>;
          },
          h1({ children }) {
            return (
              <h1 style={{ fontSize: "1.4em", fontWeight: 700, margin: "0.8em 0 0.4em" }}>
                {children}
              </h1>
            );
          },
          h2({ children }) {
            return (
              <h2 style={{ fontSize: "1.2em", fontWeight: 700, margin: "0.8em 0 0.4em" }}>
                {children}
              </h2>
            );
          },
          h3({ children }) {
            return (
              <h3 style={{ fontSize: "1.05em", fontWeight: 700, margin: "0.7em 0 0.3em" }}>
                {children}
              </h3>
            );
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                {children}
              </a>
            );
          },
          blockquote({ children }) {
            return (
              <blockquote
                style={{
                  margin: "0.5em 0",
                  paddingLeft: 12,
                  borderLeft: "3px solid var(--border)",
                  color: "var(--text-muted)",
                }}
              >
                {children}
              </blockquote>
            );
          },
          table({ children }) {
            return (
              <div style={{ overflowX: "auto", margin: "0.5em 0" }}>
                <table
                  style={{
                    borderCollapse: "collapse",
                    fontSize: "0.9em",
                    border: "1px solid var(--border)",
                  }}
                >
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th
                style={{
                  padding: "6px 10px",
                  textAlign: "left",
                  background: "var(--surface-2)",
                  borderBottom: "1px solid var(--border)",
                  fontWeight: 700,
                }}
              >
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td
                style={{
                  padding: "6px 10px",
                  borderBottom: "1px solid var(--border-soft)",
                }}
              >
                {children}
              </td>
            );
          },
          hr() {
            return (
              <hr
                style={{
                  border: 0,
                  borderTop: "1px solid var(--border)",
                  margin: "1em 0",
                }}
              />
            );
          },
        }}
      >
        {safe}
      </ReactMarkdown>
    </div>
  );
}

/**
 * While Claude is streaming, the buffer may end mid-code-block:
 *   "Here's a fix:\n```ts\nconst x = 1;"
 * react-markdown would render everything after the opening ``` as code and
 * the rest of the document — when it eventually arrives — would still be
 * inside that broken code block until the closing fence shows up.
 *
 * This helper:
 *   1. Counts fenced code-block markers (lines starting with ``` or ~~~, up
 *      to 3 leading spaces per CommonMark).
 *   2. If the count is odd, synthesises a matching closing fence so the open
 *      block renders correctly *for the current tick*.
 *   3. Also closes a dangling inline code span (single backtick) on the
 *      current line so half-typed `code` doesn't swallow the cursor.
 *
 * The fix is per-render only — when the real closing fence arrives in the
 * next chunk, our virtual one collapses naturally.
 */
function balanceStreamingMarkdown(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. Triple-fence code blocks (``` or ~~~).
  const fenceMatches = out.match(/^[ ]{0,3}(```|~~~)/gm) ?? [];
  if (fenceMatches.length % 2 === 1) {
    const last = fenceMatches[fenceMatches.length - 1]?.trim() ?? "```";
    const closer = last.startsWith("~") ? "~~~" : "```";
    // Make sure we're on a new line — adding the closer on the same line as
    // the last char would break languages that require fence on its own line.
    out = out.endsWith("\n") ? out + closer : out + "\n" + closer;
  }

  // 2. Inline backticks — only worry about the last line; multi-line inline
  // code is unusual in agent responses. Count single-backtick runs that are
  // NOT part of a triple fence on the final line.
  const lastNl = out.lastIndexOf("\n");
  const lastLine = lastNl === -1 ? out : out.slice(lastNl + 1);
  // Strip any triple-fences from the line before counting single backticks.
  const stripped = lastLine.replace(/```+/g, "");
  const single = (stripped.match(/`/g) ?? []).length;
  if (single % 2 === 1) {
    out += "`";
  }

  return out;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        margin: "0.6em 0",
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid var(--border)",
        background: "#282c34",
      }}
    >
      <div
        className="row between"
        style={{
          padding: "6px 12px",
          background: "var(--surface-2)",
          fontSize: 11.5,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span className="mono">{lang}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* swallow — older browsers */
            }
          }}
          style={{
            background: "none",
            border: "none",
            color: copied ? "var(--ok)" : "var(--text-muted)",
            fontSize: 11.5,
            cursor: "pointer",
            padding: 0,
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: "12px 14px",
          fontSize: 13,
          background: "transparent",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-mono, monospace)" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
