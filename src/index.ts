import type { ArgumentOptions, Config } from './interfaces.js';
import { camelToKebab, kebabToCamel, padString } from './utils.js';

export type * from './interfaces.js';

export function parseArgs(config: Config): Record<string, any> {
  const { command, options, version } = config;
  const args = process.argv.slice(2);
  const result: Record<string, any> = {};

  // Check for duplicate aliases
  const aliasMap = new Map<string, string>();
  for (const [key, opt] of Object.entries(options)) {
    if (opt.alias) {
      const optAlias = opt.alias as string;
      if (aliasMap.has(optAlias)) {
        throw new Error(`Duplicate alias detected: "${opt.alias}" used for both "${aliasMap.get(optAlias)}" and "${key}"`);
      }
      aliasMap.set(optAlias, key);
    }
  }

  // Handle --help and --version before anything else
  if (args.includes('--help') || args.includes('-h')) {
    printHelp(config);
    process.exit(0);
  }
  if ((version && args.includes('--version')) || args.includes('-v')) {
    console.log(version || 'No version specified');
    process.exit(0);
  }

  // Validate: required positionals must come before optional ones
  const positionals = command.positional ?? [];
  let foundOptional = false;
  for (const pos of positionals) {
    if (!pos.required) {
      foundOptional = true;
    }
    if (foundOptional && pos.required) {
      throw new Error(`Invalid positional argument configuration: required positional "${pos.name}" cannot follow optional positional(s).`);
    }
  }

  // Handle positional arguments
  let argIndex = 0;
  const nonOptionArgs: string[] = [];
  while (argIndex < args.length && !args[argIndex].startsWith('-')) {
    nonOptionArgs.push(args[argIndex]);
    argIndex++;
  }

  let nonOptionIndex = 0;
  for (let i = 0; i < positionals.length; i++) {
    const pos = positionals[i];
    if (pos.variadic) {
      const remaining = positionals.length - (i + 1);
      const values = nonOptionArgs.slice(nonOptionIndex, nonOptionArgs.length - remaining);
      if (pos.required && values.length === 0) {
        const usagePositionals = positionals.map(posArg => `<${posArg.name}>`).join(' ');
        throw new Error(`Missing required positional argument, i.e.: "${command.name} ${usagePositionals}"`);
      }
      result[pos.name] = !pos.required && values.length === 0 && pos.default !== undefined ? pos.default : values;
      nonOptionIndex += values.length;
    } else {
      const value = nonOptionArgs[nonOptionIndex];
      // Check if there are enough args left for required positionals
      const requiredLeft = positionals.slice(i).filter(p => p.required).length;
      const argsLeft = nonOptionArgs.length - nonOptionIndex;
      if (value !== undefined && (argsLeft > requiredLeft - (pos.required ? 1 : 0) || pos.required)) {
        result[pos.name] = value;
        nonOptionIndex++;
      } else if (!pos.required && pos.default !== undefined) {
        result[pos.name] = pos.default;
      } else if (pos.required) {
        const usagePositionals = positionals.map(posArg => `<${posArg.name}>`).join(' ');
        throw new Error(`Missing required positional argument, i.e.: "${command.name} ${usagePositionals}"`);
      }
    }
  }

  // Handle options
  // Start parsing options after all non-option args used for positionals
  argIndex = 0;
  const consumedArgs = new Set<number>();
  // Mark all nonOptionArgs indices as consumed for positionals
  let tempNonOptionIndex = 0;
  for (let i = 0; i < positionals.length; i++) {
    const pos = positionals[i];
    if (pos.variadic) {
      const remaining = positionals.length - (i + 1);
      const values = nonOptionArgs.slice(tempNonOptionIndex, nonOptionArgs.length - remaining);
      for (let j = tempNonOptionIndex; j < tempNonOptionIndex + values.length; j++) {
        consumedArgs.add(args.findIndex((a, idx) => !a.startsWith('-') && !consumedArgs.has(idx) && a === nonOptionArgs[j]));
      }
      tempNonOptionIndex += values.length;
    } else {
      const value = nonOptionArgs[tempNonOptionIndex++];
      consumedArgs.add(args.findIndex((a, idx) => !a.startsWith('-') && !consumedArgs.has(idx) && a === value));
    }
  }

  while (argIndex < args.length) {
    if (consumedArgs.has(argIndex)) {
      argIndex++;
      continue;
    }
    const argOrg = args[argIndex] || '';
    let arg = args[argIndex];
    let option: ArgumentOptions | undefined;
    let configKey: string | undefined;

    if (argOrg.startsWith('-')) {
      if (argOrg.startsWith('--')) {
        arg = argOrg.slice(2);
        // Try all forms: as-is, kebab-to-camel, camel-to-kebab
        option = options[arg] || options[kebabToCamel(arg)] || options[camelToKebab(arg).replace(/-/g, '')];
        if (option) {
          // Find the actual config key
          for (const key of Object.keys(options)) {
            if (options[key] === option) {
              configKey = key;
              break;
            }
          }
        }
        if (!option) {
          // Try matching aliases in all forms
          for (const key of Object.keys(options)) {
            const opt = options[key];
            if (opt.alias && (opt.alias.includes(arg) || opt.alias.includes(kebabToCamel(arg)) || opt.alias.includes(camelToKebab(arg)))) {
              option = opt;
              configKey = key;
              break;
            }
          }
        }
      } else if (argOrg.startsWith('-')) {
        // alias
        arg = argOrg.slice(1);
        if (arg) {
          const optionKeys = Object.keys(options);
          for (let j = 0; j < optionKeys.length; j++) {
            const opt = options[optionKeys[j]];
            if (opt.alias && (opt.alias === arg || opt.alias === kebabToCamel(arg) || opt.alias === camelToKebab(arg))) {
              option = opt;
              configKey = optionKeys[j];
              break;
            }
          }
        }
      }

      if (!option) {
        // Handle negated boolean in both forms
        const isNegated = arg.startsWith('no-');
        const optionName = isNegated ? arg.slice(3) : arg;
        const camelOptionName = kebabToCamel(optionName);
        option = options[optionName] || options[camelOptionName];
        configKey = camelOptionName in options ? camelOptionName : optionName;
        if (option?.type === 'boolean') {
          if (result[optionName] !== undefined || result[camelOptionName] !== undefined) {
            throw new Error('Providing same negated and truthy argument are not allowed');
          }
          result[configKey] = !isNegated;
          argIndex++;
          continue;
        }
      }

      if (!option || !configKey) {
        throw new Error(`Unknown option: ${arg}`);
      }

      switch (option.type) {
        case 'boolean':
          if (result[configKey] !== undefined) {
            throw new Error('Providing same negated and truthy argument are not allowed');
          }
          result[configKey] = !argOrg.startsWith('--no-') && !argOrg.startsWith('-no-');
          break;
        case 'number':
          if (args[argIndex + 1] === undefined || args[argIndex + 1].startsWith('-')) {
            throw new Error(`Missing value for option: ${configKey}`);
          }
          result[configKey] = Number(args[++argIndex]);
          break;
        case 'array': {
          if (!result[configKey]) result[configKey] = [];
          const arrayValue = args[++argIndex];
          if (arrayValue === undefined || arrayValue.startsWith('-')) {
            throw new Error(`Missing value for array option: ${configKey}`);
          }
          result[configKey].push(arrayValue);
          break;
        }
        case 'string':
        default:
          if (args[argIndex + 1] === undefined || args[argIndex + 1].startsWith('-')) {
            throw new Error(`Missing value for option: ${configKey}`);
          }
          result[configKey] = args[++argIndex];
          break;
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    argIndex++;
  }

  // After all parsing, assign any `default` CLI options when undefined
  // and check for any missing `required` CLI options
  Object.entries(options).forEach(([key, opt]) => {
    if (result[key] === undefined && opt.default !== undefined) {
      result[key] = opt.default;
    }
    if (opt.required && result[key] === undefined) {
      const aliasStr = opt.alias ? `-${opt.alias}, ` : '';
      throw new Error(`Missing required option: ${aliasStr}--${key}`);
    }
  });

  return result;
}

/** print CLI help documentation to the screen */
function printHelp(config: Config) {
  const { command, options, version } = config;

  // Build usage string for positionals
  const usagePositionals = (command.positional ?? [])
    .map(p => {
      const variadic = p.variadic ? '..' : '';
      if (p.required) {
        return `<${p.name}${variadic}>`;
      }
      return `[${p.name}${variadic}]`;
    })
    .join(' ');
  console.log('Usage:');
  console.log(`  ${command.name} ${usagePositionals} [options]  ${command.description}`);
  console.log('\nPositionals:');
  command.positional?.forEach(arg => {
    console.log(`  ${arg.name.padEnd(20)}${arg.description.slice(0, 65).padEnd(65)}[${arg.type || 'string'}]`);
  });

  // Build usage string for options
  console.log('\nOptions:');
  Object.keys(options).forEach(key => {
    const option = options[key];
    const requiredStr = option.required ? '[required]' : '';
    const aliasStr = option.alias ? `-${option.alias}, ` : '';
    console.log(
      `  ${aliasStr.padEnd(4)}--${key.padEnd(14)}${(option.description || '').slice(0, 65).padEnd(65)}[${option.type || 'string'}]${requiredStr}`,
    );
  });

  // Print default options (help and version)
  console.log('\nDefault options:');
  console.log(`${padString('  -h, --help', 21)} ${padString('Show help', 64)} [boolean]`);
  if (version) {
    console.log(`${padString('  -v, --version', 21)} ${padString('Show version number', 64)} [boolean]`);
  }
  console.log('\n');
}
