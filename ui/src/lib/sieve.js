// Sieve rule builder/parser
//
// Handles the subset of sieve we generate:
//   require ["fileinto", "envelope", "mailbox"];
//   if header :contains "List-Id" "value" { fileinto :create "Folder"; }
//   elsif address :is "to" "addr" { fileinto :create "Folder"; }
//   elsif header :contains "X-Spam-Flag" "YES" { fileinto :create "Spam"; }
//   else { keep; }

export function parseScript(script) {
  if (!script || !script.trim()) return { rules: [] };

  const rules = [];
  const lines = script.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip require, blank lines, closing braces
    if (!line || line.startsWith('require') || line === '}') continue;

    // Match: if/elsif/else with test and action
    const condMatch = line.match(/^(?:if|elsif)\s+(.+?)\s*\{$/);
    const elseMatch = line.match(/^(?:\}\s*)?else\s*\{$/);
    const inlineMatch = line.match(/^(?:if|elsif)\s+(.+?)\s*\{\s*(.+?)\s*\}$/);
    const elseInlineMatch = line.match(/^(?:\}\s*)?else\s*\{\s*(.+?)\s*\}$/);

    let test = null;
    let action = null;

    if (inlineMatch) {
      test = parseTest(inlineMatch[1]);
      action = parseAction(inlineMatch[2]);
    } else if (elseInlineMatch) {
      test = { type: 'true' };
      action = parseAction(elseInlineMatch[1]);
    } else if (condMatch) {
      test = parseTest(condMatch[1]);
      // Action is on the next line(s)
      action = findAction(lines, i + 1);
    } else if (elseMatch) {
      test = { type: 'true' };
      action = findAction(lines, i + 1);
    } else {
      continue;
    }

    if (test && action) {
      rules.push({ test, action });
    }
  }

  return { rules };
}

function findAction(lines, startIdx) {
  for (let j = startIdx; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l && l !== '}') return parseAction(l);
  }
  return null;
}

function parseTest(str) {
  str = str.trim();

  // header :contains "field" "value"
  const headerMatch = str.match(/^header\s+:(contains|is)\s+"([^"]+)"\s+"([^"]*)"$/);
  if (headerMatch) {
    return { type: 'header', match: headerMatch[1], field: headerMatch[2], value: headerMatch[3] };
  }

  // address :is "to" "value"
  const addrMatch = str.match(/^address\s+:(contains|is)\s+"([^"]+)"\s+"([^"]*)"$/);
  if (addrMatch) {
    return { type: 'address', match: addrMatch[1], field: addrMatch[2], value: addrMatch[3] };
  }

  // true (catch-all)
  if (str === 'true') {
    return { type: 'true' };
  }

  return null;
}

function parseAction(str) {
  str = str.trim();

  // fileinto :create "Folder";
  const fileintoCreate = str.match(/^fileinto\s+:create\s+"([^"]+)"\s*;$/);
  if (fileintoCreate) {
    return { type: 'fileinto', folder: fileintoCreate[1] };
  }

  // fileinto "Folder";
  const fileinto = str.match(/^fileinto\s+"([^"]+)"\s*;$/);
  if (fileinto) {
    return { type: 'fileinto', folder: fileinto[1] };
  }

  // redirect "address";
  const redirect = str.match(/^redirect\s+"([^"]+)"\s*;$/);
  if (redirect) {
    return { type: 'redirect', address: redirect[1] };
  }

  // discard; or discard; stop;
  if (str.match(/^discard\s*;(\s*stop\s*;)?$/)) {
    return { type: 'discard' };
  }

  // keep;
  if (str.match(/^keep\s*;$/)) {
    return { type: 'keep' };
  }

  return null;
}

export function compileRules(rules) {
  if (!rules || rules.length === 0) return '';

  // Determine required extensions
  const requires = new Set();
  for (const rule of rules) {
    if (rule.action.type === 'fileinto') {
      requires.add('fileinto');
      requires.add('mailbox');
    }
    if (rule.action.type === 'redirect') {
      // redirect is a base command, no require needed
    }
    if (rule.test.type === 'address') {
      requires.add('envelope');
    }
  }

  let script = '';
  if (requires.size > 0) {
    const sorted = [...requires].sort();
    script += `require [${sorted.map(r => `"${r}"`).join(', ')}];\n\n`;
  }

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const keyword = i === 0 ? 'if' : (rule.test.type === 'true' ? '} else' : '} elsif');
    const testStr = compileTest(rule.test);
    const actionStr = compileAction(rule.action);

    if (rule.test.type === 'true') {
      script += `${keyword} {\n  ${actionStr}\n`;
    } else {
      script += `${keyword} ${testStr} {\n  ${actionStr}\n`;
    }
  }

  script += '}\n';
  return script;
}

function compileTest(test) {
  switch (test.type) {
    case 'header':
      return `header :${test.match} "${test.field}" "${test.value}"`;
    case 'address':
      return `address :${test.match} "${test.field}" "${test.value}"`;
    case 'true':
      return '';
    default:
      return 'true';
  }
}

function compileAction(action) {
  switch (action.type) {
    case 'fileinto':
      return `fileinto :create "${action.folder}";`;
    case 'redirect':
      return `redirect "${action.address}";`;
    case 'discard':
      return 'discard; stop;';
    case 'keep':
      return 'keep;';
    default:
      return 'keep;';
  }
}
