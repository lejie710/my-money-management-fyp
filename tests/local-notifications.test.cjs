const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const project = path.resolve(__dirname, '..');
const packageRoot = path.join(project, 'node_modules/expo-notifications');
const facade = path.join(project, 'src/reminders/localNotifications.ts');
const blocked =
  /(?:^|\/)(?:index|topicSubscription|TopicSubscriptionModule(?:\.android)?|DevicePushTokenAutoRegistration\.fx|getDevicePushTokenAsync|getExpoPushTokenAsync|unregisterForNotificationsAsync|TokenEmitter|PushTokenManager(?:\.native)?|ServerRegistrationModule(?:\.native)?|registerTaskAsync|unregisterTaskAsync|BackgroundNotificationTasksModule(?:\.native)?)\.js$/;

function runtimeImports(file) {
  const tree = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
  function walk(node) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      assert.equal(node.arguments.length, 1, `Unexpected dynamic module expression in ${file}`);
      assert.ok(
        ts.isStringLiteral(node.arguments[0]),
        `Uninspectable dynamic dependency in ${file}`,
      );
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, walk);
  }
  walk(tree);
  return imports;
}

function resolveModule(from, specifier, platform) {
  assert.notEqual(
    specifier,
    'expo-notifications',
    'Local facade must not import the eager package root.',
  );
  let base;
  if (specifier.startsWith('expo-notifications/'))
    base = path.join(packageRoot, specifier.slice('expo-notifications/'.length));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier);
  else return null; // Shared Expo/React Native runtime is outside this package graph.
  const candidates =
    path.extname(base) === '.js'
      ? [base]
      : [`${base}.${platform}.js`, `${base}.native.js`, `${base}.js`];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(resolved, `Missing shipped entrypoint ${specifier} from ${from}`);
  assert.ok(
    resolved.startsWith(`${packageRoot}${path.sep}`),
    'Dependency must remain inside the inspected notifications package.',
  );
  return resolved;
}

for (const platform of ['android', 'ios'])
  test(`local notification facade avoids remote-only modules in the ${platform} dependency graph`, () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(
      metadata.version,
      '58.1.5',
      'Re-review the version-specific facade after a package change.',
    );
    assert.equal(
      metadata.exports,
      undefined,
      'Re-review deep-entrypoint accessibility if package exports are introduced.',
    );
    const visited = new Set();
    const external = new Set();
    const visit = (file) => {
      if (visited.has(file)) return;
      visited.add(file);
      if (file !== facade) {
        const relative = path.relative(packageRoot, file).replaceAll(path.sep, '/');
        assert.equal(
          blocked.test(relative),
          false,
          `Remote-only/eager dependency reached: ${relative}`,
        );
        const text = fs.readFileSync(file, 'utf8');
        assert.equal(
          /requireNativeModule\(['"]Expo(?:TopicSubscription|PushToken|BackgroundNotificationTasks)/.test(
            text,
          ),
          false,
          `Unexpected remote native requirement in ${relative}`,
        );
      }
      for (const specifier of runtimeImports(file)) {
        const target = resolveModule(file, specifier, platform);
        if (target) visit(target);
        else external.add(specifier);
      }
    };
    visit(facade);
    const files = [...visited].map((file) => path.basename(file));
    assert.ok(files.includes('NotificationScheduler.native.js'));
    assert.ok(files.includes('NotificationPermissionsModule.native.js'));
    assert.ok(files.includes('NotificationsEmitterModule.native.js'));
    assert.ok(files.includes('NotificationsHandlerModule.native.js'));
    if (platform === 'android') {
      assert.ok(files.includes('getNotificationChannelAsync.android.js'));
      assert.ok(files.includes('setNotificationChannelAsync.android.js'));
      assert.ok(files.includes('NotificationChannelManager.native.js'));
    }
    assert.deepEqual([...external].sort(), ['expo']);
  });

test('application adapter imports only the local facade and facade exposes no wildcard runtime exports', () => {
  const adapterImports = runtimeImports(path.join(project, 'src/reminders/expoAdapter.ts'));
  assert.ok(adapterImports.includes('./localNotifications'));
  assert.equal(
    adapterImports.some(
      (name) => name === 'expo-notifications' || name.startsWith('expo-notifications/'),
    ),
    false,
  );
  const tree = ts.createSourceFile(
    facade,
    fs.readFileSync(facade, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of tree.statements)
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      assert.ok(
        statement.exportClause && ts.isNamedExports(statement.exportClause),
        'Facade runtime exports must be explicitly named.',
      );
    }
});
