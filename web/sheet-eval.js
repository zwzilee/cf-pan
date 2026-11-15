/* 表格公式前端求值 —— 与 src/sheet.ts 的 evalFormula/displayValue 保持一致，只做显示用 */
(function () {
  function colToIndex(letters) {
    var n = 0;
    letters = String(letters).toUpperCase();
    for (var k = 0; k < letters.length; k++) {
      var d = letters.charCodeAt(k) - 64;
      if (d < 1 || d > 26) return -1;
      n = n * 26 + d;
    }
    return n - 1;
  }
  function indexToCol(i) {
    var s = '', n = i + 1;
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function evalFormula(raw, get, depth) {
    depth = depth || 0;
    if (depth > 8) return '#循环';
    var src = raw.slice(1), i = 0;
    function num(v) {
      if (v === '' || v == null) return 0;
      var n = Number(v);
      if (!isFinite(n)) throw new Error('#值');
      return n;
    }
    function readRange() {
      var start = i;
      while (i < src.length && /[A-Za-z0-9:$]/.test(src[i])) i++;
      var ref = src.slice(start, i);
      var m = /^\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(ref);
      if (!m) throw new Error('#引用');
      var c1 = colToIndex(m[1]), r1 = parseInt(m[2], 10) - 1;
      var c2 = colToIndex(m[3]), r2 = parseInt(m[4], 10) - 1;
      var out = [];
      for (var r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
        for (var c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
          var v = get(r, c);
          if (v === '' || v == null) continue;
          if (v.charAt(0) === '=') {
            var inner = evalFormula(v, get, depth + 1);
            if (inner.charAt(0) === '#') continue;
            out.push(Number(inner));
          } else {
            var nn = Number(v);
            if (isFinite(nn)) out.push(nn);
          }
        }
      }
      return out;
    }
    function expr() {
      var v = term();
      while (i < src.length) {
        var ch = src[i];
        if (ch === '+') { i++; v += term(); }
        else if (ch === '-') { i++; v -= term(); }
        else break;
      }
      return v;
    }
    function term() {
      var v = factor();
      while (i < src.length) {
        var ch = src[i];
        if (ch === '*') { i++; v *= factor(); }
        else if (ch === '/') { i++; var d = factor(); if (d === 0) throw new Error('#除零'); v /= d; }
        else break;
      }
      return v;
    }
    function factor() {
      while (src[i] === ' ') i++;
      if (src[i] === '(') {
        i++;
        var v = expr();
        if (src[i] !== ')') throw new Error('#括号');
        i++;
        return v;
      }
      if (src[i] === '-') { i++; return -factor(); }
      var fn = /^(SUM|AVG|AVERAGE|MIN|MAX|COUNT)\(/i.exec(src.slice(i));
      if (fn) {
        i += fn[0].length;
        var nums = readRange();
        if (src[i] !== ')') throw new Error('#函数');
        i++;
        var f = fn[1].toUpperCase();
        if (f === 'SUM') return nums.reduce(function (a, b) { return a + b; }, 0);
        if (f === 'AVG' || f === 'AVERAGE') return nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : 0;
        if (f === 'MIN') return nums.length ? Math.min.apply(null, nums) : 0;
        if (f === 'MAX') return nums.length ? Math.max.apply(null, nums) : 0;
        if (f === 'COUNT') return nums.length;
      }
      var cell = /^\$?([A-Za-z]+)\$?(\d+)/.exec(src.slice(i));
      if (cell) {
        i += cell[0].length;
        var rr = parseInt(cell[2], 10) - 1;
        var cc = colToIndex(cell[1]);
        var cv = get(rr, cc);
        if (cv && cv.charAt(0) === '=') {
          var inner = evalFormula(cv, get, depth + 1);
          return inner.charAt(0) === '#' ? 0 : num(inner);
        }
        return num(cv);
      }
      var nm = /^\d+(\.\d+)?/.exec(src.slice(i));
      if (nm) { i += nm[0].length; return Number(nm[0]); }
      throw new Error('#语法');
    }
    try {
      var val = expr();
      if (i < src.length) return '#语法';
      return Number.isInteger(val) ? String(val) : String(Math.round(val * 1e10) / 1e10);
    } catch (e) {
      var msg = e && e.message ? e.message : '';
      return msg.charAt(0) === '#' ? msg : '#错误';
    }
  }
  function displayValue(cells, r, c, stack) {
    var raw = cells.get(r + ',' + c);
    if (raw == null) raw = '';
    if (raw.charAt(0) !== '=') return raw;
    if ((stack || 0) > 8) return '#循环';
    return evalFormula(raw, function (rr, cc) { var x = cells.get(rr + ',' + cc); return x == null ? '' : x; }, stack || 0);
  }
  window.SheetEval = { colToIndex: colToIndex, indexToCol: indexToCol, evalFormula: evalFormula, displayValue: displayValue };
})();
