<?php
/**
 * Read each v1 endpoint's request-body fields out of the Tickiti source, for
 * scripts/build-manifest.mjs. The route table knows path params but not body fields,
 * and most v1 controllers pass straight through to the UI controllers, so this
 * follows the call from the route's action into the method that validates.
 *
 *   php scripts/body-fields.php <tickiti dir> < routes.json > fields.json
 *
 * routes.json is `php artisan route:list --json --path=api/v1`. The output maps a
 * route name to { fields: { name: rules }, required: [names] }.
 *
 * It reads the methods' source with PHP's tokenizer and calls none of them, but it is
 * not inert: it requires the checkout's vendor/autoload.php (which runs Composer's
 * 'files' autoloads), autoloads the App\ classes it reflects on, and reads class
 * constants through reflection (which evaluates their constant expressions). So
 * <tickiti dir> must be a checkout you trust. What it finds:
 *  - the rules given to ->validate(...), Validator::make(..., ...) and
 *    $this->validate($r, ...), field => rules: an array written in place, a variable
 *    built before, a class constant (X::RULES) or what a method returns (X::rules(),
 *    $this->rules(), a FormRequest parameter's rules()), and what is added to them with
 *    '+' (self::ticketRules() + [...]); Validator::make's rules are its second argument,
 *    and one whose data is an array written in place checks a worked-out value, not the
 *    body, so it is skipped;
 *  - fields read with $request->input('x') and its relatives (get, boolean, file, ...),
 *    which have no rules ('?'); a rule seen anywhere replaces a '?' seen first;
 *  - calls it can follow: app(X::class)->m(...), (new X)->m(...), X::m(...),
 *    $this->m(...), self::/static::m(...) and $v->m(...) where $v is typed with a class
 *    (a parameter, or a closure's), up to MAX_DEPTH deep, within App\.
 * A computed part of a rule ('max:' . self::MAX, Rule::in(X::VALUES)) is filled in from
 * the constant when it can be, and shown as '…' when it cannot.
 * A field is required only when its rules say a bare 'required'. Conditional rules
 * (required_with, required_if, ...) are left to the rules text. MERGING names the
 * update endpoints that keep what a call leaves out: they require only their id.
 * FILLED_IN names fields an endpoint fills in itself before its rules run.
 */

const MAX_DEPTH = 4;

/**
 * Update endpoints that merge the call with what is stored (what is left out keeps its
 * value), mapped to what they require: their id. They validate the merged record with
 * the page's rules, whose 'required' is the page's and not the caller's.
 */
const MERGING = [
    'api.v1.settings.availability.update' => ['id'],
    'api.v1.workflow.automations.update' => ['id'],
    'api.v1.workflow.checklist_templates.update' => ['id'],
    'api.v1.workflow.interventions.update' => ['intervention_id'],
    'api.v1.workflow.recurring_tasks.update' => ['id'],
    'api.v1.workflow.sla_policies.update' => ['id'],
];

/**
 * Fields an endpoint fills in before the rules it shares with another run, so their
 * 'required' is not the caller's: field => what replaces 'required' ('' drops it).
 * respond and close take ticket_id instead of ticket_number; close and the participant
 * changes default from_email to the token's owner.
 */
const FILLED_IN = [
    'api.v1.tickets.respond' => ['ticket_number' => 'required_without:ticket_id'],
    'api.v1.tickets.close' => ['ticket_number' => 'required_without:ticket_id', 'from_email' => ''],
    'api.v1.tickets.participants_add' => ['from_email' => ''],
    'api.v1.tickets.participants_remove' => ['from_email' => ''],
];

/**
 * Methods not followed: what they validate is not the caller's body. validateChanges and
 * applyChanges check and apply a change set built from stored data (the change an Axial
 * skill proposal holds, a skill store export); axial/chat/skill-proposal reaches them with
 * only proposal_id and decision.
 */
const NOT_FOLLOWED = [
    'App\\Services\\Axial\\AxialSkillService@validateChanges',
    'App\\Services\\Axial\\AxialSkillService@applyChanges',
];
const READERS = ['input', 'get', 'boolean', 'integer', 'string', 'float', 'date', 'array', 'collect',
    'filled', 'has', 'hasFile', 'file', 'query', 'post', 'exists', 'missing', 'json', 'enum'];
const REQUEST_VARS = ['$r', '$request', '$req', '$rq'];
/** Fields a followed call reads that are never a caller's body field (see the filter below). */
const NOT_BODY = ['idempotency_key', 'secure_id', 'ticket_number_or_secure_id', 'tickiti_tab_token'];

$dir = rtrim($argv[1] ?? '', '/\\');
if ($dir === '' || ! is_file("$dir/vendor/autoload.php")) {
    fwrite(STDERR, "usage: php body-fields.php <tickiti dir> < routes.json\n");
    exit(2);
}
require "$dir/vendor/autoload.php";

$routes = json_decode(stream_get_contents(STDIN), true);
if (! is_array($routes)) {
    fwrite(STDERR, "routes.json on stdin is not a JSON array\n");
    exit(2);
}

/** Method source tokens, cached by "Class@method". */
$tokenCache = [];
/** Short-name => FQCN map per file, from its `use` lines and namespace. */
$useCache = [];

function method_tokens(string $class, string $method): ?array
{
    global $tokenCache;
    $key = "$class@$method";
    if (array_key_exists($key, $tokenCache)) {
        return $tokenCache[$key];
    }
    $tokenCache[$key] = null;
    try {
        $rm = new ReflectionMethod($class, $method);
    } catch (Throwable $e) {
        return null;
    }
    $file = $rm->getFileName();
    if (! $file || ! is_file($file)) {
        return null;
    }
    $lines = file($file);
    $src = implode('', array_slice($lines, $rm->getStartLine() - 1, $rm->getEndLine() - $rm->getStartLine() + 1));
    $tokens = array_values(array_filter(
        token_get_all("<?php\n" . $src),
        fn ($t) => ! (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT, T_OPEN_TAG], true)),
    ));

    return $tokenCache[$key] = ['tokens' => $tokens, 'file' => $file, 'class' => $rm->getDeclaringClass()->getName(),
        'params' => $rm->getParameters()];
}

function uses_of(string $file, string $class): array
{
    global $useCache;
    if (isset($useCache[$file])) {
        return $useCache[$file];
    }
    $map = [];
    $text = (string) file_get_contents($file);
    if (preg_match('/^namespace\s+([\w\\\\]+);/m', $text, $m)) {
        $map['__ns'] = $m[1];
    }
    preg_match_all('/^use\s+([\w\\\\]+)(?:\s+as\s+(\w+))?;/m', $text, $all, PREG_SET_ORDER);
    foreach ($all as $u) {
        $short = $u[2] ?? '';
        if ($short === '') {
            $parts = explode('\\', $u[1]);
            $short = end($parts);
        }
        $map[$short] = $u[1];
    }

    return $useCache[$file] = $map;
}

function resolve_class(string $name, string $file, string $self): ?string
{
    if (in_array(strtolower($name), ['self', 'static'], true)) {
        return $self;
    }
    $name = ltrim($name, '\\');
    $uses = uses_of($file, $self);
    $first = explode('\\', $name)[0];
    if (isset($uses[$first])) {
        $fq = $uses[$first] . substr($name, strlen($first));
    } elseif (isset($uses['__ns']) && ! str_contains($name, '\\')) {
        $fq = $uses['__ns'] . '\\' . $name;
    } else {
        $fq = $name;
    }

    return str_starts_with($fq, 'App\\') && class_exists($fq) ? $fq : null;
}

function tok_text($t): string
{
    return is_array($t) ? $t[1] : $t;
}

function tok_is($t, $id, ?string $text = null): bool
{
    if (is_array($t)) {
        return $t[0] === $id && ($text === null || strcasecmp($t[1], $text) === 0);
    }

    return $t === $id;
}

function unquote(string $s): string
{
    $q = $s[0] ?? '';
    if ($q === "'") {
        // single-quoted: only \\ and \' are escapes, so a regex keeps its \d
        return strtr(substr($s, 1, -1), ['\\\\' => '\\', "\\'" => "'"]);
    }

    return $q === '"' ? stripcslashes(substr($s, 1, -1)) : $s;
}

/** Index of the token closing the bracket/paren opened at $i. */
function closing(array $tokens, int $i): int
{
    $open = tok_text($tokens[$i]);
    $close = ['[' => ']', '(' => ')', '{' => '}'][$open] ?? null;
    $depth = 0;
    for ($j = $i, $n = count($tokens); $j < $n; $j++) {
        $t = tok_text($tokens[$j]);
        if ($t === '[' || $t === '(' || $t === '{' || $t === '${' || (is_array($tokens[$j]) && $tokens[$j][0] === T_CURLY_OPEN)) {
            $depth++;
        } elseif ($t === ']' || $t === ')' || $t === '}') {
            $depth--;
            if ($depth === 0) {
                return $j;
            }
        }
    }

    return $n - 1;
}

/** A rule or a read for $f: a rule replaces a read ('?', 'file'), never another rule. */
function put_field(array &$fields, string $f, string $r): void
{
    if (! isset($fields[$f]) || (in_array($fields[$f], ['?', 'file'], true) && ! in_array($r, ['?', 'file'], true))) {
        $fields[$f] = $r;
    }
}

/** The class a name in $ctx's file means (self/static: $ctx's class), within App\. */
function ctx_class(string $name, array $ctx): ?string
{
    return $ctx ? resolve_class($name, $ctx['file'], $ctx['class']) : null;
}

/** A class constant's value through reflection, or null when it cannot be had. */
function const_value(string $class, string $const, array $ctx): mixed
{
    $fq = ctx_class($class, $ctx);
    if (! $fq) {
        return null;
    }
    try {
        return (new ReflectionClassConstant($fq, $const))->getValue();
    } catch (Throwable $e) {
        return null;
    }
}

/** True when tokens[$k..] is a class name, '::' and a name (X::NAME, self::NAME). */
function is_static_ref(array $tokens, int $k): bool
{
    $t = $tokens[$k] ?? null;

    return (tok_is($t, T_STRING) || tok_is($t, T_STATIC) || tok_is($t, T_NAME_QUALIFIED) || tok_is($t, T_NAME_FULLY_QUALIFIED))
        && tok_is($tokens[$k + 1] ?? null, T_DOUBLE_COLON) && tok_is($tokens[$k + 2] ?? null, T_STRING);
}

/** A rules value (a constant's, or a method's returned array) as field => rules text. */
function rules_from_value(mixed $value): ?array
{
    if (! is_array($value) || ! $value || ! is_string(array_key_first($value))) {
        return null;
    }
    $out = [];
    foreach ($value as $f => $r) {
        $parts = [];
        foreach (is_array($r) ? $r : explode('|', (string) $r) as $p) {
            if (is_string($p)) {
                $parts[] = $p;
            } elseif ($p instanceof Closure) {
                $parts[] = 'custom check';
            } elseif (is_object($p) && method_exists($p, '__toString')) {
                $parts[] = (string) $p;
            } elseif (is_object($p)) {
                $parts[] = 'custom check';
            }
        }
        $out[(string) $f] = implode('|', array_filter($parts, fn ($p) => $p !== ''));
    }

    return $out;
}

/**
 * A string literal at $j and what is concatenated onto it ('max:' . self::MAX), as one
 * text, with a part that cannot be worked out shown as '…'. Returns [text, last index].
 */
function concat_text(array $tokens, int $j, int $end, array $ctx): array
{
    $text = unquote($tokens[$j][1]);
    $k = $j;
    while ($k + 2 < $end && tok_text($tokens[$k + 1]) === '.') {
        $k += 2;
        $t = $tokens[$k];
        if (tok_is($t, T_CONSTANT_ENCAPSED_STRING) || tok_is($t, T_LNUMBER) || tok_is($t, T_DNUMBER)) {
            $text .= unquote($t[1]);
        } elseif (is_static_ref($tokens, $k) && tok_text($tokens[$k + 3] ?? '') !== '(') {
            $v = const_value($t[1], $tokens[$k + 2][1], $ctx);
            $text .= is_scalar($v) ? (string) $v : '…';
            $k += 2;
        } elseif (is_static_ref($tokens, $k) && tok_text($tokens[$k + 3] ?? '') === '(') {
            $text .= '…';
            $k = closing($tokens, $k + 3);
        } elseif ((tok_is($t, T_STRING) || tok_is($t, T_NAME_QUALIFIED) || tok_is($t, T_NAME_FULLY_QUALIFIED))
            && tok_text($tokens[$k + 1] ?? '') === '(') {
            // implode(',', ...) and other calls
            $text .= '…';
            $k = closing($tokens, $k + 1);
        } elseif (tok_text($t) === '(') {
            $text .= '…';
            $k = closing($tokens, $k);
        } elseif (tok_is($t, T_VARIABLE)) {
            $text .= '…';
            // $x->y, $x->y(...), $x['y']
            while (true) {
                if (tok_is($tokens[$k + 1] ?? null, T_OBJECT_OPERATOR) && tok_is($tokens[$k + 2] ?? null, T_STRING)) {
                    $k += 2;
                    if (tok_text($tokens[$k + 1] ?? '') === '(') {
                        $k = closing($tokens, $k + 1);
                    }
                } elseif (tok_text($tokens[$k + 1] ?? '') === '[') {
                    $k = closing($tokens, $k + 1);
                } else {
                    break;
                }
            }
        } else {
            $text .= '…';
            $k -= 2;
            break;
        }
    }

    return [preg_replace('/…+/u', '…', $text), $k];
}

/**
 * The values of Rule::in(...) / Rule::notIn(...) whose '(' is at $open: literals, an
 * array of literals, or a class constant holding them. Null when they are computed.
 */
function in_values(array $tokens, int $open, int $close, array $ctx): ?array
{
    $args = array_slice($tokens, $open + 1, $close - $open - 1);
    if (! $args) {
        return null;
    }
    if (tok_text($args[0]) === '[' && closing($args, 0) === count($args) - 1) {
        $args = array_slice($args, 1, -1);
    }
    if (count($args) === 3 && is_static_ref($args, 0)) {
        $v = const_value($args[0][1], $args[2][1], $ctx);
        if (is_array($v) && $v && array_filter($v, 'is_scalar') === $v) {
            return array_map('strval', array_values($v));
        }

        return null;
    }
    $vals = [];
    foreach ($args as $a) {
        if (tok_is($a, T_CONSTANT_ENCAPSED_STRING) || tok_is($a, T_LNUMBER)) {
            $vals[] = unquote($a[1]);
        } elseif (tok_text($a) !== ',') {
            return null;
        }
    }

    return $vals ?: null;
}

/**
 * Field => rules from a rules array whose '[' is at $i, or null when it is not one
 * (its first entry is not 'string' => ...). $ctx (file, class) resolves the class
 * constants and names a rule refers to.
 */
function rules_array(array $tokens, int $i, array $ctx = []): ?array
{
    $end = closing($tokens, $i);
    $out = [];
    $j = $i + 1;
    while ($j < $end) {
        if (! tok_is($tokens[$j], T_CONSTANT_ENCAPSED_STRING) || ! tok_is($tokens[$j + 1] ?? null, T_DOUBLE_ARROW)) {
            if (! $out) {
                return null;
            }
            $j++;
            continue;
        }
        $field = unquote($tokens[$j][1]);
        $j += 2;
        // The value runs to the next ',' at this depth.
        $parts = [];
        $depth = 0;
        $conditional = false;
        for (; $j < $end; $j++) {
            $t = $tokens[$j];
            $tx = tok_text($t);
            if ($depth === 0 && $tx === ',') {
                break;
            }
            if ($depth <= 1 && ($tx === '?' || tok_is($t, T_COALESCE) || tok_is($t, T_IF))) {
                // $creating ? 'prohibited' : 'required' - both strings are not both rules
                $conditional = true;
            }
            if (in_array($tx, ['[', '(', '{'], true) || (is_array($t) && $t[0] === T_CURLY_OPEN)) {
                $depth++;
            } elseif (in_array($tx, [']', ')', '}'], true)) {
                $depth--;
            }
            if (tok_is($t, T_FUNCTION) || tok_is($t, T_FN)) {
                $parts[] = 'custom check';
                $j = skip_closure($tokens, $j, $end);
                continue;
            }
            $isRule = tok_is($t, T_STRING, 'Rule')
                || ((tok_is($t, T_NAME_QUALIFIED) || tok_is($t, T_NAME_FULLY_QUALIFIED)) && str_ends_with($t[1], '\\Rule'));
            if ($isRule && tok_is($tokens[$j + 1] ?? null, T_DOUBLE_COLON)) {
                // Rule::in([...]) / Rule::exists('t') -> in:a,b / exists:t
                $name = tok_text($tokens[$j + 2] ?? '');
                $open = $j + 3;
                if (tok_text($tokens[$open] ?? '') === '(') {
                    $close = closing($tokens, $open);
                    $rule = strtolower(preg_replace('/(?<!^)[A-Z]/', '_$0', $name));
                    if (in_array($rule, ['in', 'not_in'], true)) {
                        // The values, or '…' when they are computed (array_map('strval', ...),
                        // Enum::values()): a callable's name is not a value.
                        $vals = in_values($tokens, $open, $close, $ctx);
                        $parts[] = $rule . ':' . ($vals === null ? '…' : implode(',', $vals));
                    } else {
                        // Only the call's own literal arguments: Rule::exists('t', 'c').
                        $vals = [];
                        $d = 0;
                        for ($k = $open + 1; $k < $close; $k++) {
                            $tk = tok_text($tokens[$k]);
                            if (in_array($tk, ['[', '(', '{'], true)) {
                                $d++;
                            } elseif (in_array($tk, [']', ')', '}'], true)) {
                                $d--;
                            } elseif ($d === 0 && (tok_is($tokens[$k], T_CONSTANT_ENCAPSED_STRING) || tok_is($tokens[$k], T_LNUMBER))) {
                                $vals[] = unquote($tokens[$k][1]);
                            }
                        }
                        $parts[] = $rule . ($vals ? ':' . implode(',', $vals) : '');
                    }
                    $j = $close;
                    continue;
                }
            }
            if ($depth <= 1 && tok_is($t, T_CONSTANT_ENCAPSED_STRING)) {
                [$text, $j] = concat_text($tokens, $j, $end, $ctx);
                $parts[] = $text;
                continue;
            }
        }
        // A bare in / in: is a value list worked out at run time - say so rather than show
        // an empty list.
        $parts = array_map(fn ($p) => ($p === 'in' || $p === 'in:') ? 'in:…' : $p, $parts);
        $rules = implode('|', array_filter($parts, fn ($p) => $p !== ''));
        $out[$field] ??= $conditional && $rules !== '' ? "depends: $rules" : $rules;
        $j++;
    }

    return $out;
}

function skip_closure(array $tokens, int $j, int $end): int
{
    // function (...) use (...) { ... }  |  fn (...) => expr
    for ($k = $j; $k < $end; $k++) {
        $tx = tok_text($tokens[$k]);
        if ($tx === '{') {
            return closing($tokens, $k);
        }
        if (tok_is($tokens[$k], T_DOUBLE_ARROW)) {
            // arrow fn: to the next ',' or ']' at this depth
            $depth = 0;
            for ($m = $k + 1; $m < $end; $m++) {
                $t = tok_text($tokens[$m]);
                if (in_array($t, ['[', '('], true)) {
                    $depth++;
                } elseif (in_array($t, [']', ')'], true)) {
                    if ($depth === 0) {
                        return $m - 1;
                    }
                    $depth--;
                } elseif ($t === ',' && $depth === 0) {
                    return $m - 1;
                }
            }
        }
    }

    return $end;
}

/** Rules built in a variable: $rules = [...]; $rules['x'] = [...]; (then ->validate($rules)). */
function rule_vars(array $t, array $ctx): array
{
    $vars = [];
    for ($i = 0, $n = count($t); $i < $n; $i++) {
        if (! tok_is($t[$i], T_VARIABLE)) {
            continue;
        }
        $v = $t[$i][1];
        if (tok_text($t[$i + 1] ?? '') === '=' && tok_text($t[$i + 2] ?? '') === '[') {
            $rules = rules_array($t, $i + 2, $ctx);
            if ($rules !== null) {
                $vars[$v] = ($vars[$v] ?? []) + $rules;
            }
        } elseif (tok_text($t[$i + 1] ?? '') === '=' && is_static_ref($t, $i + 2) && tok_text($t[$i + 5] ?? '') !== '(') {
            // $rules = X::RULES;
            $rules = rules_from_value(const_value($t[$i + 2][1], $t[$i + 4][1], $ctx));
            if ($rules !== null) {
                $vars[$v] = ($vars[$v] ?? []) + $rules;
            }
        } elseif (tok_text($t[$i + 1] ?? '') === '[' && tok_is($t[$i + 2] ?? null, T_CONSTANT_ENCAPSED_STRING)
            && tok_text($t[$i + 3] ?? '') === ']' && tok_text($t[$i + 4] ?? '') === '=') {
            // $rules['x'] = [...] / 'rule' : parse it as a one-entry array
            $value = tok_text($t[$i + 5] ?? '') === '['
                ? array_slice($t, $i + 5, closing($t, $i + 5) - $i - 4)
                : [$t[$i + 5] ?? "''"];
            $one = rules_array(array_merge(['[', $t[$i + 2], [T_DOUBLE_ARROW, '=>']], $value, [']']), 0, $ctx);
            if ($one !== null) {
                $vars[$v] = ($vars[$v] ?? []) + $one;
            }
        }
    }

    return $vars;
}

/**
 * The rules a method returns (FormRequest::rules(), ReminderService::rules()): its
 * `return [...]`, `return $rules` built in it, or `return X::RULES`. Null when it
 * returns none of those.
 */
function returned_rules(string $class, string $method): ?array
{
    $m = method_tokens($class, $method);
    if (! $m) {
        return null;
    }
    $t = $m['tokens'];
    $ctx = ['file' => $m['file'], 'class' => $m['class']];
    $vars = null;
    $out = null;
    for ($i = 0, $n = count($t); $i < $n; $i++) {
        if (! tok_is($t[$i], T_RETURN)) {
            continue;
        }
        $rules = null;
        if (tok_text($t[$i + 1] ?? '') === '[') {
            $rules = rules_array($t, $i + 1, $ctx);
        } elseif (tok_is($t[$i + 1] ?? null, T_VARIABLE) && tok_text($t[$i + 2] ?? '') === ';') {
            $vars ??= rule_vars($t, $ctx);
            $rules = $vars[$t[$i + 1][1]] ?? null;
        } elseif (is_static_ref($t, $i + 1) && tok_text($t[$i + 4] ?? '') === ';') {
            $rules = rules_from_value(const_value($t[$i + 1][1], $t[$i + 3][1], $ctx));
        }
        if ($rules !== null) {
            $out = ($out ?? []) + $rules;
        }
    }

    return $out;
}

/**
 * Class names typed onto variables in a method: its parameters, and the parameters of the
 * closures in it (fn (Request $request, AxialTurnController $panel) => $panel->m(...)).
 * Only App\ classes, which are the ones followed.
 */
function typed_vars(array $m): array
{
    $ctx = ['file' => $m['file'], 'class' => $m['class']];
    $typed = [];
    foreach ($m['params'] as $p) {
        $type = $p->getType();
        $name = $type instanceof ReflectionNamedType ? $type->getName() : null;
        if ($name && str_starts_with($name, 'App\\') && class_exists($name)) {
            $typed['$' . $p->getName()] = $name;
        }
    }
    $t = $m['tokens'];
    for ($i = 1, $n = count($t); $i < $n; $i++) {
        $prev = tok_text($t[$i - 1]);
        if ((tok_is($t[$i], T_STRING) || tok_is($t[$i], T_NAME_QUALIFIED) || tok_is($t[$i], T_NAME_FULLY_QUALIFIED))
            && tok_is($t[$i + 1] ?? null, T_VARIABLE) && in_array($prev, ['(', ',', '?'], true)) {
            $cls = ctx_class($t[$i][1], $ctx);
            if ($cls) {
                $typed[$t[$i + 1][1]] = $cls;
            }
        }
    }

    return $typed;
}

/** The index just after the ',' ending the call argument that starts at $k ($close: none). */
function next_arg(array $t, int $k, int $close): int
{
    for (; $k < $close; $k++) {
        $tx = tok_text($t[$k]);
        if ($tx === ',') {
            return $k + 1;
        }
        if (in_array($tx, ['[', '(', '{'], true)) {
            $k = closing($t, $k);
        }
    }

    return $close;
}

/**
 * One rules expression at $k in a validate call's arguments: an array written in place, a
 * variable built before, a class constant (X::RULES) or a method's returned rules
 * (X::rules(), $this->rules()). Returns [field => rules or null, its last token's index].
 */
function rules_term(array $t, int $k, array $vars, array $ctx): array
{
    $tx = tok_text($t[$k] ?? '');
    $ends = [',', ')', '+'];
    if ($tx === '[') {
        return [rules_array($t, $k, $ctx), closing($t, $k)];
    }
    if (tok_is($t[$k] ?? null, T_VARIABLE) && isset($vars[$t[$k][1]]) && in_array(tok_text($t[$k + 1] ?? ''), $ends, true)) {
        return [$vars[$t[$k][1]], $k];
    }
    if (is_static_ref($t, $k) && tok_text($t[$k + 3] ?? '') === '(') {
        $target = ctx_class($t[$k][1], $ctx);

        return [$target ? returned_rules($target, $t[$k + 2][1]) : null, closing($t, $k + 3)];
    }
    if (is_static_ref($t, $k) && in_array(tok_text($t[$k + 3] ?? ''), $ends, true)) {
        return [rules_from_value(const_value($t[$k][1], $t[$k + 2][1], $ctx)), $k + 2];
    }
    if (tok_is($t[$k] ?? null, T_VARIABLE) && $t[$k][1] === '$this' && tok_is($t[$k + 1] ?? null, T_OBJECT_OPERATOR)
        && tok_is($t[$k + 2] ?? null, T_STRING) && tok_text($t[$k + 3] ?? '') === '(') {
        return [returned_rules($ctx['class'], $t[$k + 2][1]), closing($t, $k + 3)];
    }
    if ($tx === '(') {
        return [null, closing($t, $k)];
    }

    return [null, $k];
}

/** Fields and the calls to follow in one method. */
function scan(string $class, string $method, int $depth, array &$seen, array &$fields): void
{
    $key = "$class@$method";
    if ($depth > MAX_DEPTH || isset($seen[$key]) || in_array($key, NOT_FOLLOWED, true)) {
        return;
    }
    $seen[$key] = true;
    $m = method_tokens($class, $method);
    if (! $m) {
        return;
    }
    $t = $m['tokens'];
    $n = count($t);
    $ctx = ['file' => $m['file'], 'class' => $m['class']];

    // A FormRequest parameter brings its rules(), read from its source (never called).
    foreach ($m['params'] as $p) {
        $type = $p->getType();
        $name = $type instanceof ReflectionNamedType ? $type->getName() : null;
        if ($name && is_subclass_of($name, \Illuminate\Foundation\Http\FormRequest::class) && method_exists($name, 'rules')) {
            foreach (returned_rules($name, 'rules') ?? [] as $f => $r) {
                put_field($fields, $f, $r);
            }
        }
    }

    $vars = rule_vars($t, $ctx);
    $typed = typed_vars($m);

    for ($i = 0; $i < $n; $i++) {
        $tok = $t[$i];

        // ->validate([...]) / $this->validate($r, [...]) / Validator::make($x, [...]), the
        // rules being a direct argument: an array, a variable built above, a class constant
        // (X::RULES) or a method's returned rules (X::rules(), $this->rules()).
        if ((tok_is($tok, T_STRING, 'validate') || tok_is($tok, T_STRING, 'validateWithBag')
                || (tok_is($tok, T_STRING, 'make') && tok_is($t[$i - 2] ?? null, T_STRING, 'Validator')))
            && tok_text($t[$i + 1] ?? '') === '(') {
            $close = closing($t, $i + 1);
            $k = $i + 2;
            if (tok_is($tok, T_STRING, 'make')) {
                // Validator::make($data, $rules): the first argument is the data, which can
                // look like rules (['name' => $r->has('name') ? ... : $model->name]). Data
                // written in place (['v' => $value], data: ['participant' => $p]) is a value
                // the method worked out, so its rules are not the caller's body fields.
                $first = tok_is($t[$k] ?? null, T_STRING) && tok_text($t[$k + 1] ?? '') === ':' ? $k + 2 : $k;
                if (tok_text($t[$first] ?? '') === '[') {
                    continue;
                }
                $k = next_arg($t, $k, $close);
            }
            for (; $k < $close; $k++) {
                [$rules, $k] = rules_term($t, $k, $vars, $ctx);
                // self::ticketRules() + [...]: each further term adds the fields not given yet
                while ($rules !== null && tok_text($t[$k + 1] ?? '') === '+') {
                    [$more, $next] = rules_term($t, $k + 2, $vars, $ctx);
                    if ($more === null) {
                        break;
                    }
                    $rules += $more;
                    $k = $next;
                }
                if ($rules !== null) {
                    foreach ($rules as $f => $r) {
                        put_field($fields, $f, $r);
                    }
                    break;
                }
            }
            continue;
        }

        // $request->input('x'), ->boolean('x'), ...
        if (tok_is($tok, T_VARIABLE) && in_array($tok[1], REQUEST_VARS, true)
            && tok_is($t[$i + 1] ?? null, T_OBJECT_OPERATOR)
            && is_array($t[$i + 2] ?? null) && $t[$i + 2][0] === T_STRING && in_array($t[$i + 2][1], READERS, true)
            && tok_text($t[$i + 3] ?? '') === '(') {
            $arg = $t[$i + 4] ?? null;
            if (tok_is($arg, T_CONSTANT_ENCAPSED_STRING)) {
                $f = unquote($arg[1]);
                put_field($fields, $f, in_array($t[$i + 2][1], ['file', 'hasFile'], true) ? 'file' : '?');
            } elseif (tok_text($arg ?? '') === '[') {
                // ->only(['a','b']) style lists
                $close = closing($t, $i + 4);
                for ($k = $i + 5; $k < $close; $k++) {
                    if (tok_is($t[$k], T_CONSTANT_ENCAPSED_STRING)) {
                        put_field($fields, unquote($t[$k][1]), '?');
                    }
                }
            }
            continue;
        }

        // $v->m( where $v is typed with an App\ class (a parameter, or a closure's)
        if (tok_is($tok, T_VARIABLE) && isset($typed[$tok[1]]) && tok_is($t[$i + 1] ?? null, T_OBJECT_OPERATOR)
            && tok_is($t[$i + 2] ?? null, T_STRING) && tok_text($t[$i + 3] ?? '') === '(') {
            scan($typed[$tok[1]], $t[$i + 2][1], $depth + 1, $seen, $fields);
            continue;
        }

        // X::m( - a static call into another App\ class (self::/static:: are below)
        if ((tok_is($tok, T_STRING) || tok_is($tok, T_NAME_QUALIFIED) || tok_is($tok, T_NAME_FULLY_QUALIFIED))
            && ! in_array(strtolower($tok[1]), ['self', 'static', 'parent'], true)
            && tok_is($t[$i + 1] ?? null, T_DOUBLE_COLON) && tok_is($t[$i + 2] ?? null, T_STRING)
            && tok_text($t[$i + 3] ?? '') === '(') {
            $target = resolve_class($tok[1], $m['file'], $m['class']);
            if ($target) {
                scan($target, $t[$i + 2][1], $depth + 1, $seen, $fields);
            }
            continue;
        }

        // app(X::class)->m(
        if (tok_is($tok, T_STRING, 'app') && tok_text($t[$i + 1] ?? '') === '('
            && tok_is($t[$i + 2] ?? null, T_STRING) && tok_is($t[$i + 3] ?? null, T_DOUBLE_COLON)
            && tok_is($t[$i + 4] ?? null, T_CLASS) && tok_text($t[$i + 5] ?? '') === ')'
            && tok_is($t[$i + 6] ?? null, T_OBJECT_OPERATOR) && tok_is($t[$i + 7] ?? null, T_STRING)) {
            $target = resolve_class($t[$i + 2][1], $m['file'], $m['class']);
            if ($target) {
                scan($target, $t[$i + 7][1], $depth + 1, $seen, $fields);
            }
            continue;
        }
        if (tok_is($tok, T_NAME_QUALIFIED) || tok_is($tok, T_NAME_FULLY_QUALIFIED)) {
            // app(\App\X::class)->m( with a qualified name
            if (tok_text($t[$i - 1] ?? '') === '(' && tok_is($t[$i - 2] ?? null, T_STRING, 'app')
                && tok_is($t[$i + 1] ?? null, T_DOUBLE_COLON) && tok_is($t[$i + 2] ?? null, T_CLASS)
                && tok_text($t[$i + 3] ?? '') === ')' && tok_is($t[$i + 4] ?? null, T_OBJECT_OPERATOR)
                && tok_is($t[$i + 5] ?? null, T_STRING)) {
                $target = resolve_class($tok[1], $m['file'], $m['class']);
                if ($target) {
                    scan($target, $t[$i + 5][1], $depth + 1, $seen, $fields);
                }
            }
            continue;
        }

        // (new X)->m(  /  (new X())->m(
        if (tok_is($tok, T_NEW) && tok_text($t[$i - 1] ?? '') === '(' && is_array($t[$i + 1] ?? null)) {
            $cls = $t[$i + 1][1];
            $k = $i + 2;
            if (tok_text($t[$k] ?? '') === '(') {
                $k = closing($t, $k) + 1;
            }
            if (tok_text($t[$k] ?? '') === ')' && tok_is($t[$k + 1] ?? null, T_OBJECT_OPERATOR) && tok_is($t[$k + 2] ?? null, T_STRING)) {
                $target = resolve_class($cls, $m['file'], $m['class']);
                if ($target) {
                    scan($target, $t[$k + 2][1], $depth + 1, $seen, $fields);
                }
            }
            continue;
        }

        // $this->m( / self::m( / static::m(
        if ((tok_is($tok, T_VARIABLE) && $tok[1] === '$this' && tok_is($t[$i + 1] ?? null, T_OBJECT_OPERATOR))
            || ((tok_is($tok, T_STRING, 'self') || tok_is($tok, T_STATIC)) && tok_is($t[$i + 1] ?? null, T_DOUBLE_COLON))) {
            if (tok_is($t[$i + 2] ?? null, T_STRING) && tok_text($t[$i + 3] ?? '') === '(') {
                scan($m['class'], $t[$i + 2][1], $depth + 1, $seen, $fields);
            }
        }
    }
}

$out = [];
foreach ($routes as $route) {
    $name = $route['name'] ?? '';
    $action = $route['action'] ?? '';
    if (! str_starts_with($name, 'api.v1.') || ! str_contains($action, '@')) {
        continue;
    }
    [$class, $method] = explode('@', $action, 2);
    $fields = [];
    $seen = [];
    scan($class, $method, 0, $seen, $fields);
    // An empty rule is a data array that looked like rules (Validator::make(['v' => $x], ...));
    // the idempotency key is checked as a field but sent as the Idempotency-Key header; and
    // the web page's own fields, read by the ticket lookup and the panel, are not a caller's
    // (the API blanks secure_id and ticket_number_or_secure_id, and has no browser tab).
    $fields = array_filter($fields, fn ($r, $f) => $r !== '' && ! in_array($f, NOT_BODY, true), ARRAY_FILTER_USE_BOTH);
    if (! $fields) {
        continue;
    }
    if (isset(MERGING[$name])) {
        // What is left out is kept, so a top-level field is not required of the caller
        // (an element's own required fields, x.*.y, still are when the list is sent).
        foreach ($fields as $f => $r) {
            if (! str_contains($f, '.') && ! in_array($f, MERGING[$name], true)) {
                $fields[$f] = implode('|', array_filter(explode('|', $r), fn ($p) => $p !== 'required'));
                if ($fields[$f] === '') {
                    $fields[$f] = '?';
                }
            }
        }
        foreach (MERGING[$name] as $f) {
            $fields[$f] = isset($fields[$f]) && $fields[$f] !== '?'
                ? (in_array('required', explode('|', $fields[$f]), true) ? $fields[$f] : "required|{$fields[$f]}")
                : 'required';
        }
    }
    foreach (FILLED_IN[$name] ?? [] as $f => $instead) {
        if (isset($fields[$f])) {
            $parts = array_map(fn ($p) => $p === 'required' ? $instead : $p, explode('|', $fields[$f]));
            $fields[$f] = implode('|', array_filter($parts, fn ($p) => $p !== '')) ?: '?';
        }
    }
    ksort($fields);
    $required = [];
    foreach ($fields as $f => $r) {
        $parts = explode('|', $r);
        if (! str_starts_with($r, 'depends:') && in_array('required', $parts, true) && ! in_array('sometimes', $parts, true)) {
            $required[] = $f;
        }
    }
    $out[$name] = ['fields' => $fields, 'required' => $required];
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
