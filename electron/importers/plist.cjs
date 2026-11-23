// Property lists (TablePlus, Sequel Ace / Sequel Pro). XML plists are parsed
// here; binary ones ("bplist00") are converted with macOS's plutil, which is
// where those apps run anyway.
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { parseXml, kids } = require("./xml.cjs");

function value(el) {
  switch (el.name) {
    case "dict": {
      const out = {};
      const c = kids(el);
      for (let i = 0; i + 1 < c.length; i += 2) if (c[i].name === "key") out[c[i].text] = value(c[i + 1]);
      return out;
    }
    case "array":
      return kids(el).map(value);
    case "string":
      return el.text;
    case "integer":
      return parseInt(el.text, 10);
    case "real":
      return parseFloat(el.text);
    case "true":
      return true;
    case "false":
      return false;
    case "date":
      return el.text;
    case "data":
      return Buffer.from(el.text.replace(/\s+/g, ""), "base64");
    default:
      return null;
  }
}

function parsePlistXml(text) {
  const root = parseXml(text);
  const plist = kids(root, "plist")[0] || root;
  const first = kids(plist)[0];
  return first ? value(first) : null;
}

function plutilToXml(file) {
  return new Promise((resolve, reject) =>
    execFile("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", file], { maxBuffer: 64 << 20 }, (err, out) => (err ? reject(err) : resolve(out))),
  );
}

async function readPlist(file) {
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8).toString("latin1") === "bplist00") {
    if (process.platform !== "darwin") throw new Error("binary plist");
    return parsePlistXml(await plutilToXml(file));
  }
  return parsePlistXml(buf.toString("utf8"));
}

module.exports = { readPlist, parsePlistXml };
