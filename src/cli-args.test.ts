import { parseCliArgs } from './cli-args.js';

/**
 * parseCliArgs is pure except for an optional exit/warn callback pair,
 * which tests override so we never call process.exit or log noise.
 */
function run(argv: string[]) {
  const warnings: string[] = [];
  let exitCode: number | null = null;
  const exit = (code: number): never => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  };
  const warn = (msg: string) => warnings.push(msg);
  try {
    const parsed = parseCliArgs(argv, { exit, warn });
    return { parsed, warnings, exitCode };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('__exit_')) {
      return { parsed: null, warnings, exitCode };
    }
    throw e;
  }
}

describe('parseCliArgs', () => {
  it('defaults to stdio mode with no args', () => {
    const { parsed, warnings, exitCode } = run(['node', 'index.js']);
    expect(parsed).toEqual({ httpMode: false, port: 3100 });
    expect(warnings).toEqual([]);
    expect(exitCode).toBeNull();
  });

  it('recognises --http alone with the 3100 default', () => {
    const { parsed } = run(['node', 'index.js', '--http']);
    expect(parsed).toEqual({ httpMode: true, port: 3100 });
  });

  it('parses --http --port N', () => {
    const { parsed } = run(['node', 'index.js', '--http', '--port', '3198']);
    expect(parsed).toEqual({ httpMode: true, port: 3198 });
  });

  it('parses --port N --http (reverse order)', () => {
    const { parsed } = run(['node', 'index.js', '--port', '4000', '--http']);
    expect(parsed).toEqual({ httpMode: true, port: 4000 });
  });

  it('warns on unknown flag and still returns a valid config', () => {
    const { parsed, warnings } = run(['node', 'index.js', '--htpp']);
    expect(parsed).toEqual({ httpMode: false, port: 3100 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unknown argument "--htpp"/);
  });

  it('warns on --http=true (typo for --http)', () => {
    const { parsed, warnings } = run(['node', 'index.js', '--http=true']);
    expect(parsed).toEqual({ httpMode: false, port: 3100 });
    expect(warnings[0]).toMatch(/--http=true/);
  });

  it('does NOT warn on the value after --port', () => {
    const { warnings } = run(['node', 'index.js', '--http', '--port', '3200']);
    expect(warnings).toEqual([]);
  });

  it('warns on a stray arg alongside valid flags', () => {
    const { parsed, warnings } = run([
      'node',
      'index.js',
      '--http',
      '--port',
      '3100',
      '--verbose',
    ]);
    expect(parsed).toEqual({ httpMode: true, port: 3100 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/--verbose/);
  });

  it.each([['abc'], ['0'], ['65536'], ['-1']])(
    'exits(1) on invalid --port value %s',
    (value) => {
      const { parsed, warnings, exitCode } = run([
        'node',
        'index.js',
        '--http',
        '--port',
        value,
      ]);
      expect(parsed).toBeNull();
      expect(exitCode).toBe(1);
      expect(warnings[0]).toMatch(/Invalid --port value/);
    }
  );
});
