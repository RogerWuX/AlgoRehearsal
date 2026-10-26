// Deliberately supports only string variables and non-nested optional sections.
// Inserted values are never parsed as template syntax.
export function renderPrompt(
  template: string,
  variables: Readonly<Record<string, string>> = {},
  sections: Readonly<Record<string, boolean>> = {},
): string {
  let output = '', position = 0, enabled = true;
  let section: string | undefined;
  const literal = (text: string) => {
    if (/\{\{|\}\}/.test(text)) throw new Error('Malformed prompt template delimiter.');
    if (enabled) output += text;
  };
  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    literal(template.slice(position, match.index));
    position = match.index! + match[0].length;
    const token = match[1].trim();
    const name = token.replace(/^[#/]/, '');
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid prompt token: ${token}`);
    if (token.startsWith('#')) {
      if (section !== undefined) throw new Error('Nested prompt sections are unsupported.');
      if (!Object.prototype.hasOwnProperty.call(sections, name)) throw new Error(`Unknown prompt section: ${name}`);
      section = name;
      enabled = sections[name];
    } else if (token.startsWith('/')) {
      if (section !== name) throw new Error(`Mismatched prompt section: ${name}`);
      section = undefined;
      enabled = true;
    } else {
      if (!Object.prototype.hasOwnProperty.call(variables, name)) throw new Error(`Missing prompt variable: ${name}`);
      if (enabled) output += variables[name];
    }
  }
  if (section !== undefined) throw new Error(`Unclosed prompt section: ${section}`);
  literal(template.slice(position));
  return output.trim();
}
