// A small, forgiving XML reader for the config files of other tools (DataGrip,
// MySQL Workbench, Navicat, property lists). Elements become
// { name, attrs, children, text }; comments, processing instructions, the
// DOCTYPE and namespaces prefixes on names are kept as-is or skipped.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e] ?? m;
  });

function parseXml(src) {
  const text = String(src).replace(/^﻿/, "");
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      top().text += unescape(text.slice(i));
      break;
    }
    if (lt > i) top().text += unescape(text.slice(i, lt));
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? text.length : end + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      top().text += text.slice(lt + 9, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end + 3;
    } else if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (text.startsWith("<!", lt)) {
      // DOCTYPE (possibly with an internal subset in brackets)
      let j = lt + 2;
      let depth = 0;
      while (j < text.length) {
        const c = text[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
        j++;
      }
      i = j + 1;
    } else if (text[lt + 1] === "/") {
      const end = text.indexOf(">", lt);
      const name = text.slice(lt + 2, end).trim();
      // close up to the matching element (tolerates stray tags)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? text.length : end + 1;
    } else {
      // start tag: scan to '>' outside quotes
      let j = lt + 1;
      let q = null;
      while (j < text.length) {
        const c = text[j];
        if (q) {
          if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === ">") break;
        j++;
      }
      const raw = text.slice(lt + 1, j);
      const selfClose = raw.endsWith("/");
      const body = selfClose ? raw.slice(0, -1) : raw;
      const m = /^\s*([^\s/>]+)/.exec(body);
      const el = { name: m ? m[1] : "", attrs: {}, children: [], text: "" };
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = re.exec(body.slice(m ? m[0].length : 0)))) el.attrs[a[1]] = unescape(a[3] ?? a[4] ?? "");
      top().children.push(el);
      if (!selfClose) stack.push(el);
      i = j + 1;
    }
  }
  return root;
}

// Helpers over the element tree.
const kids = (el, name) => (el?.children || []).filter((c) => !name || c.name === name);
const kid = (el, name) => (el?.children || []).find((c) => c.name === name) || null;
function* walk(el) {
  for (const c of el?.children || []) {
    yield c;
    yield* walk(c);
  }
}
const findAll = (el, name) => [...walk(el)].filter((c) => c.name === name);
const textOf = (el) => (el ? el.text.trim() : "");

module.exports = { parseXml, kids, kid, findAll, walk, textOf };
