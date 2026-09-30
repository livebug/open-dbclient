/**
 * The Simplified Chinese message catalog.
 *
 * Keyed by the English text exactly as it appears in `t('...')`. A key that is missing here simply
 * stays English, so a gap is visible rather than fatal - but every string a user can see is meant to
 * be here, which is why the file is grouped by the module each entry comes from.
 *
 * Placeholders are `{0}`, `{1}`… in the *order the English message has them*, so a translation may
 * reorder them freely.
 */
export const ZH_CN: Record<string, string> = {
  // ---- result grid & panel ----
  'Result - {0}': '结果 - {0}',
  'Error - {0}': '错误 - {0}',
  'The connection for this result is no longer open.': '该结果所属的连接已不再打开。',
  First: '首页',
  Previous: '上一页',
  Next: '下一页',
  Last: '末页',
  'Rows {0}–{1} of {2}': '第 {0}–{1} 行,共 {2} 行',
  'Go to row': '跳到行',
  'Export…': '导出…',
  Cancel: '取消',
  'Run again': '重新执行',
  'Running…': '执行中…',
  'The statement failed.': '语句执行失败。',
  'The statement completed.': '语句已完成。',
  'Run a query to see results here.': '执行查询后,结果会显示在这里。',
  'No rows returned.': '没有返回任何行。',
  'Double-click to see the full value': '双击查看完整内容',
  '{0} row(s)': '{0} 行',
  '{0} column(s)': '{0} 列',
  'Truncated at {0} rows. Export to get everything.': '已在 {0} 行处截断,导出可获取全部数据。',
  '{0} row(s) affected.': '影响 {0} 行。',
  'Copy value': '复制单元格值',
  'Copy column name': '复制列名',
  'Copy row': '复制整行',
  'Copy row as JSON': '复制整行为 JSON',
  'Copy all column names': '复制所有列名',
  Value: '值',
  Close: '关闭',
  'Could not copy to the clipboard: {0}': '无法写入剪贴板:{0}',

  // ---- connection form ----
  Connection: '连接',
  'Add Connection': '新建连接',
  'Edit Connection': '编辑连接',
  'Test the connection before saving it. Nothing is stored until it works.':
    '先测试连通再保存 —— 连不上就不会存进配置。',
  Driver: '驱动',
  Name: '名称',
  'A label for this connection': '给这个连接起个名字',
  'JDBC URL': 'JDBC URL',
  User: '用户',
  'Leave empty when the URL carries the credentials': 'URL 里已经带凭据时可以留空',
  Password: '密码',
  'Show password': '显示密码',
  'Hide password': '隐藏密码',
  'Leave empty to keep the stored password.': '留空表示继续使用已保存的密码。',
  Properties: '属性',
  'Extra JDBC properties, separated by semicolons.': '额外的 JDBC 属性,用分号分隔。',
  'Test Connection': '测试连接',
  'Testing…': '测试中…',
  Save: '保存',
  'Test the connection to enable Save.': '测试通过后才能保存。',
  'Test the connection before saving it.': '请先测试连接再保存。',
  'A name is required': '名称不能为空',
  'Choose a JDBC driver.': '请选择 JDBC 驱动。',
  'No driver is loaded': '没有已加载的驱动',
  'saved driver': '已保存的驱动',
  'Connected in {0} ms. {1}': '连接成功,耗时 {0} 毫秒。{1}',
  'Something went wrong.': '出了点问题。',
  'A JDBC URL is required': 'JDBC URL 不能为空',
  "A JDBC URL starts with 'jdbc:'": "JDBC URL 必须以 'jdbc:' 开头",
  "'{0}' is not key=value": "'{0}' 不是 key=value 形式",

  // ---- variables view ----
  'SQL Script Variables': 'SQL 脚本变量',
  '{0} placeholder(s)': '{0} 个占位符',
  '{0} variable(s)': '{0} 个变量',
  'Script variables': '脚本变量',
  'Click to edit their values.': '点击编辑它们的值。',
  'This script has no ${NAME} placeholders.': '当前脚本里没有 ${NAME} 形式的占位符。',
  'Values are substituted before the statement runs. A placeholder with no value stops the run.':
    '这些值会在语句执行前替换进去;有占位符没填值会拒绝执行。',
  value: '值',

  // ---- completion ----
  'table or view': '表或视图',
  schema: '模式',
  catalog: '目录',
  '{0} · {1} table(s)': '{0} · {1} 张表',
  '{0}.{1}': '{0}.{1}',
  'Primary key': '主键',
  snippet: '代码片段',
  // The code lens above every statement.
  Run: '执行',

  // ---- health monitoring ----
  '{0}% heap · {1} conn': '{0}% 堆 · {1} 个连接',
  ' · {0} running': ' · {0} 个执行中',
  '**JDBC bridge** — up {0}': '**JDBC 桥** —— 已运行 {0}',
  'Heap: {0} of {1} ({2}%)': '堆:{0} / {1}({2}%)',
  'Metaspace: {0}': 'Metaspace:{0}',
  'GC: {0} run(s), {1}% of uptime': 'GC:{0} 次,占运行时间 {1}%',
  'Threads: {0} (peak {1})': '线程:{0}(峰值 {1})',
  'Result cache: {0} in {1} result(s)': '结果缓存:{0},共 {1} 个结果',
  'Queries: {0} done, {1} failed': '查询:完成 {0},失败 {1}',
  '_Click for the full report._': '_点击查看完整报告。_',
  'JDBC bridge health': 'JDBC 桥健康监控',
  'Captured {0} · up {1}': '采集于 {0} · 已运行 {1}',
  '> These figures describe the bridge process and its JDBC layer only. Database-side counters':
    '> 这些数字只描述桥进程和它的 JDBC 层 —— 数据库服务端的计数器',
  '> are not included, because reaching them would require vendor-specific SQL.':
    '> 不在这里,因为取它们需要方言相关的 SQL。',
  Memory: '内存',
  '| Measure | Value |': '| 指标 | 数值 |',
  '| --- | --- |': '| --- | --- |',
  'Heap used': '已用堆',
  'Heap committed': '已提交堆',
  'Heap maximum': '最大堆',
  'Heap used (%)': '堆使用率(%)',
  'Non-heap used': '非堆已用',
  Metaspace: 'Metaspace',
  'Garbage collection': '垃圾回收',
  'Collections: **{0}** · total time: **{1} ms** (**{2}%** of uptime)':
    '回收次数 **{0}** · 总耗时 **{1} 毫秒**(占运行时间 **{2}%**)',
  '| Collector | Collections | Time (ms) |': '| 回收器 | 次数 | 耗时(毫秒) |',
  '| --- | ---: | ---: |': '| --- | ---: | ---: |',
  Threads: '线程',
  'Current **{0}** · peak **{1}** · daemon **{2}**': '当前 **{0}** · 峰值 **{1}** · 守护线程 **{2}**',
  Protocol: '协议',
  'Handled **{0}** · failed **{1}** · in flight **{2}** · handlers **{3}**':
    '已处理 **{0}** · 失败 **{1}** · 处理中 **{2}** · 处理器 **{3}**',
  Connections: '连接',
  '_No connections are open._': '_当前没有打开的连接。_',
  '| Connection | Active | Idle | Total | Max | Waiting | Timeouts | Avg wait (ms) |':
    '| 连接 | 活跃 | 空闲 | 总数 | 上限 | 等待 | 超时 | 平均等待(毫秒) |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |':
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  'Result cache': '结果缓存',
  '**{0}** result(s) holding **{1}** of a {2} budget.': '**{0}** 个结果占用 **{1}**,预算 {2}。',
  'Least-recently-used results are discarded when the budget is exceeded.':
    '超出预算时按最近最少使用淘汰。',
  '| Query | Connection | Rows | Size | Columns | Age | Idle |':
    '| 查询 | 连接 | 行数 | 大小 | 列数 | 存在时长 | 空闲时长 |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |': '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  Queries: '查询',
  'Running **{0}** · completed **{1}** · failed **{2}** · cancelled **{3}**':
    '执行中 **{0}** · 已完成 **{1}** · 失败 **{2}** · 已取消 **{3}**',
  'Average duration **{0} ms** · slowest **{1} ms**': '平均耗时 **{0} 毫秒** · 最慢 **{1} 毫秒**',
  'Slowest statement:': '最慢的语句:',
  'Recent statements': '近期执行的语句',
  '| Time | Connection | Result | Duration | Rows | Statement |':
    '| 时间 | 连接 | 结果 | 耗时 | 行数 | 语句 |',
  '| --- | --- | --- | ---: | ---: | --- |': '| --- | --- | --- | ---: | ---: | --- |',
  'Metadata calls': '元数据调用',
  'Reading a table list, the columns of a table or a DDL statement goes through `DatabaseMetaData`. On some drivers those are large catalog queries, so the statement can finish in milliseconds while the reads around it take minutes. Listed by total time.':
    '表列表、表的列、建表语句都要走 `DatabaseMetaData`。有些驱动把这些实现成了巨大的目录查询,于是语句本身几毫秒就结束,围着它的读取却要几分钟。下表按总耗时排序。',
  '| Call | Count | Total | Average | Failures |': '| 调用 | 次数 | 总耗时 | 平均 | 失败 |',
  '| --- | ---: | ---: | ---: | ---: |': '| --- | ---: | ---: | ---: | ---: |',
  'Slowest reads:': '最慢的几次读取:',
  '| Duration | Connection | Result | Call | Subject |': '| 耗时 | 连接 | 结果 | 调用 | 对象 |',
  '| ---: | --- | --- | --- | --- |': '| ---: | --- | --- | --- | --- |',
  ok: '成功',
  failed: '失败',
  'Could not read bridge health: {0}': '无法读取桥的健康数据:{0}',

  // ---- extension & commands ----
  'Add a connection first.': '请先新建一个连接。',
  'Add Driver Jar…': '添加驱动 jar…',
  'Add JDBC driver': '添加 JDBC 驱动',
  'All loaded successfully': '全部加载成功',
  '{0} could not be loaded': '{0} 个未能加载',
  '{0} driver(s) loaded': '已加载 {0} 个驱动',
  'Loaded by explicit class name': '通过显式类名加载',
  'From {0}': '来自 {0}',
  'No JDBC drivers are loaded. Add a driver jar to connect to a database.':
    '还没有加载任何 JDBC 驱动。添加一份驱动 jar 才能连接数据库。',
  'No JDBC driver is loaded. A driver jar is needed before a connection can be created.':
    '还没有加载任何 JDBC 驱动。创建连接之前需要一份驱动 jar。',
  'Open Driver Folder': '打开驱动目录',
  "Saved connection '{0}'.": '已保存连接「{0}」。',
  Connect: '连接',
  '{0} copy': '{0} 副本',
  "Delete the saved connection '{0}'? The database itself is not affected.":
    '删除已保存的连接「{0}」?不会影响数据库本身。',
  Delete: '删除',
  'Connecting to {0}': '正在连接 {0}',
  'Connection failed: {0}': '连接失败:{0}',
  'Connected to {0} in {1} ms.': '已连接 {0},耗时 {1} 毫秒。',
  'Open a SQL file first.': '请先打开一个 SQL 文件。',
  'No saved connections yet.': '还没有已保存的连接。',
  'Attach this file to a connection': '把这个文件绑定到一个连接',
  'The choice is written into the file as a comment': '选择结果会以注释形式写进文件',
  'Filter tables, views and columns': '按名称筛选表、视图、列',
  'Show only names containing this text. Leave empty to clear.':
    '只显示名称包含这段文字的对象。留空即清除筛选。',
  'e.g. order': '例如 order',
  'Could not load JDBC drivers: {0}': '无法加载 JDBC 驱动:{0}',
  'Restart the JDBC bridge? Every open connection will be closed and results will be discarded.':
    '重启 JDBC 桥?所有已打开的连接会被关闭,结果缓存会被丢弃。',
  Restart: '重启',
  'Restarting the JDBC bridge': '正在重启 JDBC 桥',
  'The JDBC bridge has been restarted.': 'JDBC 桥已重启。',
  'Could not restart the bridge: {0}': '无法重启 JDBC 桥:{0}',
  'Schema information refreshed.': '表结构信息已刷新。',
  'The example metadata queries are already configured.': '示例元数据 SQL 已经配置过了。',
  "Add {0} example metadata query rule(s) to your user settings? They answer the tree's schema and table reads for PostgreSQL-compatible connections with information_schema instead of the driver, which is usually much faster.":
    '把 {0} 条示例元数据 SQL 规则写进用户设置?它们让连接树的模式/表查询对兼容 PostgreSQL 的连接改用 information_schema,而不是走驱动 —— 通常快得多。',
  Add: '添加',
  'Added {0} example metadata query rule(s).': '已添加 {0} 条示例元数据 SQL 规则。',
  'Reading the database metadata took longer than {0} s, so the extension stopped waiting. The database may still be working on it. A faster query can be given in the metadata.queries setting, and metadata.timeoutSeconds raises the limit.':
    '读取数据库元数据超过 {0} 秒,插件已停止等待(数据库那边可能还在跑)。可以在 `metadata.queries` 里给一条更快的 SQL,或调大 `metadata.timeoutSeconds`。',
  'Open Settings': '打开设置',
  'No custom actions are defined yet.': '还没有定义任何自定义动作。',
  'None of the {0} custom action(s) applies to a {1}.': '{0} 个自定义动作都不适用于 {1}。',
  'Run an action on {0}': '在 {0} 上运行动作',
  'The connection for this object is no longer saved.': '该对象所属的连接已不再保存。',
  "The action '{0}' uses {1}, which is not available on a {2}.":
    "动作「{0}」用到了 {1},而 {2} 上没有这些信息。",
  'The connection for this table is no longer saved.': '该表所属的连接已不再保存。',
  'No connection is associated with this editor.': '当前编辑器没有关联任何连接。',
  'No statement is currently running.': '当前没有正在执行的语句。',
  'Could not cancel the statement: {0}': '无法取消语句:{0}',
  'Open a SQL file to run a query.': '请打开一个 SQL 文件再执行查询。',
  'There is nothing to run.': '没有可执行的语句。',
  'Run all {0} statements?': '执行全部 {0} 条语句?',
  'Run All': '全部执行',
  'There is no statement at the cursor.': '光标处没有语句。',
  'Fill in {0} before running this statement.': '执行这条语句之前请先填写 {0}。',
  'Open a SQL file to export a query.': '请打开一个 SQL 文件再导出查询。',
  'There is no statement to export.': '没有可导出的语句。',
  'Fill in {0} before exporting this statement.': '导出这条语句之前请先填写 {0}。',
  '-- Columns of {0}': '-- {0} 的列',
  Type: '类型',
  Null: '可空',
  Key: '键',
  Default: '默认值',
  YES: '是',
  NO: '否',
  '-- The driver reported no columns.': '-- 驱动没有上报任何列。',
  'Could not read columns: {0}': '无法读取列信息:{0}',
  '-- Indexes of {0}': '-- {0} 的索引',
  '(unnamed)': '(未命名)',
  '-- The driver reported no indexes.': '-- 驱动没有上报任何索引。',
  'Could not read indexes: {0}': '无法读取索引:{0}',
  'Could not generate DDL: {0}': '无法生成 DDL:{0}',
  "The DDL query '{0}' uses {1}, which is not available for this table.":
    "取 DDL 的规则「{0}」用到了 {1},而这张表上没有这些信息。",
  'Reading the DDL of {0}': '正在读取 {0} 的 DDL',
  'DDL - {0}': 'DDL - {0}',
  'Clear the whole query history?': '清空全部查询历史?',
  Clear: '清空',
  'This file is not attached to a connection': '这个文件还没有绑定连接',
  'This statement affects an unbounded number of rows or drops an object:\n\n{0}':
    '这条语句会影响不限行数的数据,或者删除对象:\n\n{0}',
  'Run Anyway': '仍然执行',

  // ---- export ----
  'There is nothing to export.': '没有可导出的内容。',
  'Export results': '导出结果',
  'Choose a format': '选择格式',
  'Comma-separated, opens in any spreadsheet': '逗号分隔,任何表格软件都能打开',
  'Array of objects, keeps types': '对象数组,保留类型',
  '.xlsx, split across sheets if very large': '.xlsx,数据很大时会拆分到多个工作表',
  'INSERT statements': 'INSERT 语句',
  'Portable SQL to load elsewhere': '可迁移到别处的 SQL',
  'CSV separator': 'CSV 分隔符',
  'CSV quoting': 'CSV 引号',
  'How should fields be quoted?': '字段怎么加引号?',
  'Only when needed': '仅必要时',
  'A field is quoted only when it contains the separator, a quote or a line break.':
    '只有当字段里含分隔符、引号或换行时,才用引号包起来。',
  'Every field': '所有字段',
  'Every value, and the header, is wrapped in quotes.': '每个值和表头都用引号包起来。',
  Never: '从不',
  'No quotes at all. A value containing the separator will make the file unreadable.':
    '完全不加引号。值里出现分隔符时,文件就会读错。',
  'current setting': '当前设置',
  'Current setting: {0}': '当前设置:{0}',
  'Any text up to {0} characters, for example ~@~.': '最多 {0} 个字符,例如 ~@~。',
  'Use at most {0} characters.': '最多 {0} 个字符。',
  'A separator cannot contain a quote or a line break.': '分隔符里不能有引号或换行。',
  Comma: '逗号',
  Semicolon: '分号',
  Tab: '制表符',
  Pipe: '竖线',
  'Other…': '其他…',
  'A separator is required': '分隔符不能为空',
  '{0} field(s) contain the separator, a quote or a line break but were written without quotes, so the file may not read back correctly.':
    '{0} 个字段含分隔符、引号或换行,但没有加引号,文件可能读不回来。',
  'A table name is required': '表名不能为空',
  'Target table': '目标表',
  'Table name to use in the INSERT statements': 'INSERT 语句里使用的表名',
  Export: '导出',
  'Exporting to {0}': '正在导出到 {0}',
  'Exported {0} row(s) to {1} ({2}).': '已导出 {0} 行到 {1}({2})。',
  Open: '打开',
  Reveal: '在文件管理器中显示',
  'Export failed: {0}': '导出失败:{0}',

  // ---- connection tree ----
  Tables: '表',
  Views: '视图',
  Indexes: '索引',
  '(unnamed index)': '(未命名索引)',
  'Type: `{0}`': '类型:`{0}`',
  ' · nullable': ' · 可空',
  ' · default `{0}`': ' · 默认值 `{0}`',
  Unique: '唯一',
  'Non-unique': '非唯一',
  'Column: `{0}`': '列:`{0}`',
  PK: '主键',
  'not null': '非空',
  auto: '自增',
  unique: '唯一',
  unknown: '未知',
  'filter: {0}': '筛选:{0}',
  Completed: '成功',
  'Failed: {0}': '失败:{0}',
  'unknown error': '未知错误',
  'just now': '刚刚',
  '{0} min ago': '{0} 分钟前',
  '{0} h ago': '{0} 小时前',
  '{0} d ago': '{0} 天前',

  // ---- drivers ----
  'The JDBC driver folder is at {0}': 'JDBC 驱动目录位于 {0}',
  'JDBC driver jar': 'JDBC 驱动 jar',
  '{0} is already in the driver folder. Replace it?': '{0} 已经在驱动目录里了。要替换吗?',
  Replace: '替换',
  'Could not copy {0}: {1}': '无法复制 {0}:{1}',
  'Download a JDBC driver from Maven Central': '从 Maven Central 下载 JDBC 驱动',
  'Coordinates as groupId:artifactId:version. Separate several with spaces or commas.':
    '坐标格式为 groupId:artifactId:version,多个用空格或逗号分隔。',
  'Downloading JDBC driver': '正在下载 JDBC 驱动',
  'Maven Central responded with {0} {1}': 'Maven Central 返回 {0} {1}',
  'Could not download {0}: {1}': '无法下载 {0}:{1}',
  '{0} downloaded but its driver could not load: {1}. The driver may need additional jars, which can be added with the same download command.':
    '{0} 已下载,但它的驱动无法加载:{1}。这个驱动可能还需要别的 jar,可以用同一个下载命令一并添加。',
  'Enter at least one groupId:artifactId:version': '至少填写一个 groupId:artifactId:version',
  "'{0}' is not groupId:artifactId:version": "'{0}' 不是 groupId:artifactId:version 形式",
  "'{0}' contains characters that are not valid in Maven coordinates":
    "'{0}' 含有 Maven 坐标不允许的字符",

  // ---- connection store & service ----
  'Open DB Client could not read its saved connections ({0}). The file was left as-is; no connections are available until it is fixed or removed.':
    'Open DB Client 无法读取已保存的连接({0})。文件保持原样;在修好或删除它之前,连接列表是空的。',
  "No saved connection with id '{0}'": "没有 id 为 '{0}' 的连接",
  "Could not connect to '{0}': {1}": '无法连接到「{0}」:{1}',
  'Password for {0}': '{0} 的密码',
  'User {0}': '用户 {0}',
  Remember: '记住',
  'Do not remember': '不记住',
  'Remember this password?': '要记住这个密码吗?',
  'Stored in the operating system keychain': '保存在操作系统钥匙串里',
  "A password is required for '{0}'.": '「{0}」需要密码。',
  "The variable pattern '{0}' is not a valid regular expression, so no variables will be substituted.":
    '变量正则「{0}」不是合法的正则表达式,因此不会替换任何变量。',
  'Queries run against **{0}**': '查询会执行在 **{0}** 上',
  'Click to change.': '点击可更改。',
  'No connection': '未绑定连接',
  "The directive names '{0}', which is not a saved connection.":
    '指令里写的是「{0}」,它不是已保存的连接。',
  'Click to attach this file to a connection.': '点击把这个文件绑定到连接。',

  // ---- Java locator & bridge ----
  'No suitable Java installation was found.': '没有找到可用的 Java 安装。',
  '{0} ({1}) could not be run': '{0}({1})无法运行',
  '{0} ({1}) is Java {2}, and version {3} or newer is required':
    '{0}({1})是 Java {2},而需要 {3} 或更高版本',
  '  - no candidates were available': '  - 没有可检查的候选',
  'Open DB Client needs Java {0} or newer to run its JDBC bridge.':
    'Open DB Client 需要 Java {0} 或更高版本来运行它的 JDBC 桥。',
  'Checked:': '已检查:',
  'Fix this by installing a JDK and either adding it to PATH, setting JAVA_HOME, or pointing the':
    '解决办法:安装 JDK 后把它加入 PATH、设置 JAVA_HOME,或者把',
  "'{0}' setting at the installation directory.": "'{0}' 设置指向该安装目录。",
  'The extension is shutting down.': '扩展正在退出。',
  "Could not start Java at '{0}': {1}": '无法启动「{0}」处的 Java:{1}',
  'The JDBC bridge did not become ready within {0} ms.{1}':
    'JDBC 桥在 {0} 毫秒内没有就绪。{1}',
  'The JDBC bridge exited with code {0} before it was ready.{1}':
    'JDBC 桥在就绪之前就以退出码 {0} 结束了。{1}',
  'The JDBC bridge stopped.': 'JDBC 桥已停止。',
  'Recent output from the bridge:': '桥最近的输出:',
  'The JDBC bridge is missing from this installation (expected at {0}). Reinstall the extension, or run "npm run bridge:compile" in a development checkout.':
    '这份安装里缺少 JDBC 桥(应该在 {0})。请重新安装扩展,或者在开发用的检出目录里执行 "npm run bridge:compile"。',
  'The JDBC bridge is not running.': 'JDBC 桥没有在运行。',

  // ---- 日志:桥与 Java ----
  'Stopping the JDBC bridge': '正在停止 JDBC 桥',
  'Starting the JDBC bridge with {0}': '正在启动 JDBC 桥:{0}',
  'The JDBC bridge did not exit in time; terminating it': 'JDBC 桥没有及时退出,强制结束它',
  'The JDBC bridge process reported an error': 'JDBC 桥进程报告了错误',
  'The JDBC bridge exited unexpectedly ({0}).{1}': 'JDBC 桥意外退出({0})。{1}',
  'Restarting the JDBC bridge in {0} ms (attempt {1} of {2}).':
    '{0} ms 后重启 JDBC 桥(第 {1} 次,最多 {2} 次)。',
  'The automatic restart of the JDBC bridge failed': '自动重启 JDBC 桥失败',
  'Using Java {0} from {1} ({2})': '使用 Java {0}({1},{2})',
  'Open DB Client activating ({0})': 'Open DB Client 正在激活({0})',
  'Open DB Client activated': 'Open DB Client 已激活',
  'Registering JDBC drivers failed': '注册 JDBC 驱动失败',

  // ---- 日志:元数据读取与规则 ----
  // 这类行是排查「为什么慢」的主要依据,所以中文里也保留连接名和对象名。
  "Reading the catalogs of {0} from the driver's metadata": '从驱动元数据读取 {0} 的目录列表',
  "Reading the schemas on {0} from the driver's metadata": '从驱动元数据读取 {0} 的模式列表',
  "Reading the table types of {0} from the driver's metadata": '从驱动元数据读取 {0} 的表类型',
  "Reading the tables of {0} on {1} from the driver's metadata":
    '从驱动元数据读取连接 {1} 上 {0} 的表',
  "Reading the columns of {0} on {1} from the driver's metadata":
    '从驱动元数据读取连接 {1} 上 {0} 的列',
  "Reading the indexes of {0} on {1} from the driver's metadata":
    '从驱动元数据读取连接 {1} 上 {0} 的索引',
  "Running metadata query '{0}' for {1} on '{2}': {3}":
    '用元数据查询「{0}」读取 {1}(连接「{2}」):{3}',
  'Metadata query definition ignored: {0}': '元数据查询定义已忽略:{0}',
  "The metadata query '{0}' uses {1}, which is not available for this read; the driver's metadata is used instead.":
    '元数据查询「{0}」用到了 {1},而这次读取拿不到它;改用驱动自己的元数据(会慢一些)。',
  "The metadata query '{0}' failed ({1}); the driver's metadata is used instead.":
    '元数据查询「{0}」失败({1});改用驱动自己的元数据。',
  "The metadata query '{0}' returned rows but no {1} column, so it was ignored.":
    '元数据查询「{0}」有返回行,但没有 {1} 列,已忽略。',
  '{0} of {1}': '{1} 的{0}',
  'the connection': '该连接',
  tables: '表',
  schemas: '模式',
  columns: '列',
  indexes: '索引',
  catalogs: '目录',
  'table types': '表类型',
  'Completion cache: {0} table(s) for {1}': '补全缓存:连接 {1} 有 {0} 张表',
  'Could not preload tables for completion: {0}': '预加载补全用的表列表失败:{0}',
  "Could not load columns of '{0}': {1}": '读取 {0} 的列失败:{1}',
  "Could not expand '{0}'": '展开「{0}」失败',

  // ---- 日志:语句执行 ----
  "Finished in {0} ms on '{1}': {2}": '在「{1}」上完成,用时 {0} ms:{2}',
  '{0} row(s) affected': '影响 {0} 行',
  "Failed on '{0}': {1} - {2}": '在「{0}」上失败:{1} - {2}',
  "Cancellation requested for '{0}'": '已请求取消「{0}」',
  'Added {0} example metadata query rule(s) to the user settings':
    '已把 {0} 条示例元数据查询规则加入用户设置',
  'Custom action definition ignored: {0}': '自定义动作定义已忽略:{0}',
  'DDL query definition ignored: {0}': 'DDL 查询定义已忽略:{0}',
  "Reading the DDL of '{0}' on '{1}' with {2}: {3}": '在「{1}」上用 {2} 读取「{0}」的 DDL:{3}',
  "Connect to '{0}' did not succeed": '连接「{0}」没有成功',

  // ---- 日志:驱动 ----
  'Loaded {0} JDBC driver(s)': '已加载 {0} 个 JDBC 驱动',
  'Driver not loaded ({0}) from {1}: {2}': '驱动未加载({0},来自 {1}):{2}',
  'an unknown class name': '类名未知',
  'an unknown jar': 'jar 未知',
  "Driver '{0}' was replaced or removed; connections using it were closed":
    '驱动「{0}」被替换或删除,用到它的连接已关闭',
  "Stopped after {0} driver jars; check the 'driverPaths' setting":
    '扫描到 {0} 个驱动 jar 后停止;请检查 driverPaths 设置',
  "'driverPaths' entry is not a file: {0}": 'driverPaths 里的这一项不是文件:{0}',
  'Copied driver jar into the driver folder: {0}': '已把驱动 jar 复制到驱动目录:{0}',
  'Could not copy {0}': '复制 {0} 失败',
  'Could not download {0}': '下载 {0} 失败',
  'Downloaded {0} ({1} KiB) from {2}': '已下载 {0}({1} KiB),来自 {2}',
  'Could not read the driver folder {0}: {1}': '读取驱动目录 {0} 失败:{1}',

  // ---- 日志:连接 ----
  'Loaded {0} saved connection(s)': '已加载 {0} 个保存的连接',
  '{0} saved connection(s) were unusable and have been ignored':
    '{0} 个保存的连接无法使用,已忽略',
  'Could not read {0}; continuing without saved connections':
    '读取 {0} 失败;本次会话没有可用的已保存连接',
  "Added connection '{0}'": '已添加连接「{0}」',
  "Updated connection '{0}'": '已更新连接「{0}」',
  "Removed connection '{0}'": '已删除连接「{0}」',
  "Connected '{0}' in {1} ms: {2}": '已连接「{0}」,用时 {1} ms:{2}',
  " on '{0}'": '(连接「{0}」)',

  // ---- 日志:导出 / 历史 / 变量 / 模板 ----
  'Exported {0} row(s) to {1} ({2} in {3} ms)': '已导出 {0} 行到 {1}({2},用时 {3} ms)',
  'Result {0} is no longer cached; re-running the statement to export it':
    '结果 {0} 已不在缓存里,重新执行语句以便导出',
  "CSV quoting was 'never' and {0} field(s) written to {1} contain the separator, a quote or a line break; the file may not read back correctly":
    'CSV 引号策略是 never,而写入 {1} 的 {0} 个字段里含有分隔符、引号或换行;该文件可能无法正确读回',
  'Query history could not be read: {0}': '读取查询历史失败:{0}',
  'Clearing query history failed: {0}': '清空查询历史失败:{0}',
  'Compacting query history failed: {0}': '整理查询历史失败:{0}',
  "Ignoring the variable pattern '{0}': it does not compile": '忽略变量匹配式「{0}」:它无法编译',
  'Merged {0} user connection template(s) over {1} bundled one(s)':
    '已用 {0} 个用户连接模板覆盖 {1} 个内置模板',
};
