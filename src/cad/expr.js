// Named parameters and formulas (like FreeCAD's Spreadsheet + expressions).
// A small parser, never eval: numbers, names, + - * / ^ %, parentheses and a few functions.

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: (d) => Math.sin((d * Math.PI) / 180), cos: (d) => Math.cos((d * Math.PI) / 180), tan: (d) => Math.tan((d * Math.PI) / 180),
  min: Math.min, max: Math.max,
};
const CONSTS = { pi: Math.PI };

export const RESERVED = new Set([...Object.keys(FUNCS), ...Object.keys(CONSTS)]);
export const validName = (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !RESERVED.has(n);

export function evalExpr(text, vars = {}) {
  const src = String(text).replace(/^\s*=/, '');
  let i = 0;
  const fail = () => { throw new Error('bad expression'); };
  const ws = () => { while (src[i] === ' ' || src[i] === '\t') i++; };
  const eat = (c) => { ws(); if (src[i] === c) { i++; return true; } return false; };

  function atom() {
    ws();
    if (eat('(')) { const v = sum(); if (!eat(')')) fail(); return v; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { i += num[0].length; return parseFloat(num[0]); }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!id) fail();
    i += id[0].length;
    if (eat('(')) {
      const f = Object.prototype.hasOwnProperty.call(FUNCS, id[0]) ? FUNCS[id[0]] : null;
      if (!f) fail();
      const args = [sum()];
      while (eat(',')) args.push(sum());
      if (!eat(')')) fail();
      return f(...args);
    }
    if (Object.prototype.hasOwnProperty.call(vars, id[0])) return vars[id[0]];
    if (Object.prototype.hasOwnProperty.call(CONSTS, id[0])) return CONSTS[id[0]];
    return fail();
  }
  function unary() { if (eat('-')) return -unary(); if (eat('+')) return unary(); return power(); }
  function power() { const b = atom(); return eat('^') ? b ** unary() : b; }
  function product() {
    let v = unary();
    for (;;) {
      if (eat('*')) v *= unary();
      else if (eat('/')) v /= unary();
      else if (eat('%')) v %= unary();
      else return v;
    }
  }
  function sum() {
    let v = product();
    for (;;) {
      if (eat('+')) v += product();
      else if (eat('-')) v -= product();
      else return v;
    }
  }
  const v = sum();
  ws();
  if (i < src.length || !Number.isFinite(v)) fail();
  return v;
}

// params: [{ name, value }] in order; a value may use the names above it.
export function paramValues(params = []) {
  const vars = {};
  const errors = [];
  for (const p of params) {
    try { vars[p.name] = evalExpr(p.value, vars); } catch { errors.push(p.name); }
  }
  return { vars, errors };
}

// Deep copy with every `expr: { key: formula }` applied to its sibling values.
export function applyExprs(value, vars, bad = []) {
  if (Array.isArray(value)) return value.map((v) => applyExprs(v, vars, bad));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const k of Object.keys(value)) if (k !== 'expr') out[k] = applyExprs(value[k], vars, bad);
  for (const [k, formula] of Object.entries(value.expr || {})) {
    try { out[k] = evalExpr(formula, vars); } catch { bad.push(formula); }
  }
  return out;
}
