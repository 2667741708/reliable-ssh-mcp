const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/gu;

function renderString(value, parameters, allowedNames) {
  return value.replace(PLACEHOLDER, (_match, name) => {
    if (!allowedNames.has(name))
      throw new Error(`Template uses undeclared parameter ${name}`);
    if (!(name in parameters))
      throw new Error(`Missing template parameter ${name}`);
    const replacement = parameters[name];
    if (typeof replacement !== "string")
      throw new Error(`Template parameter ${name} must be a string`);
    return replacement;
  });
}

export function renderTemplate(template, parameters = {}) {
  const allowedNames = new Set(template.parameters);
  for (const name of Object.keys(parameters)) {
    if (!allowedNames.has(name))
      throw new Error(`Unexpected template parameter ${name}`);
  }
  return {
    program: renderString(template.program, parameters, allowedNames),
    args: template.args.map((value) =>
      renderString(value, parameters, allowedNames),
    ),
    cwd: template.cwd
      ? renderString(template.cwd, parameters, allowedNames)
      : undefined,
    env: Object.fromEntries(
      Object.entries(template.env).map(([key, value]) => [
        key,
        renderString(value, parameters, allowedNames),
      ]),
    ),
    timeoutSeconds: template.timeoutSeconds,
  };
}
