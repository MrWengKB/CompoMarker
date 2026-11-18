// 宽松地修复模型输出的 JSON：
// - 字符串里没转义的英文双引号（如学生原文里的 "你好"）
// - 字符串里的换行、制表符
// - 结尾多余的逗号
// - 输出被截断时，自动补齐引号和括号（尽量保住前面已经生成的内容）
// 返回 { value, truncated }，无法修复时抛出异常。

export function repairJSON(src) {
  const s = String(src);
  let out = '';
  let inStr = false;
  const stack = [];

  const nextNonSpace = (i) => {
    for (let j = i; j < s.length; j++) if (!/\s/.test(s[j])) return s[j];
    return '';
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') {
        if (i + 1 < s.length) {
          out += c + s[i + 1];
          i++;
        }
        continue;
      }
      if (c === '"') {
        const n = nextNonSpace(i + 1);
        if (n === '' || n === ',' || n === '}' || n === ']' || n === ':') {
          inStr = false;
          out += c;
        } else {
          out += '\\"';
        }
        continue;
      }
      if (c === '\n') out += '\\n';
      else if (c === '\r') continue;
      else if (c === '\t') out += '\\t';
      else out += c;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
      out += c;
    } else if (c === '}' || c === ']') {
      stack.pop();
      out += c;
    } else {
      out += c;
    }
  }

  const truncated = inStr || stack.length > 0;
  if (inStr) out += '"';
  if (stack.length) {
    // 截断时去掉末尾不完整的部分，再补齐括号
    out = out.replace(/\s+$/, '');
    if (/:\s*$/.test(out)) out += 'null';
    out = out.replace(/,\s*$/, '');
    // 末尾是一个孤立的对象键（"key"）时去掉它
    out = out.replace(/([{,])\s*"[^"]*"\s*$/, (m, p) => (p === ',' ? '' : p));
    while (stack.length) out += stack.pop();
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  return { value: JSON.parse(out), truncated };
}
