# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/),格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

### 变更

- **`package-lock.json` 里的 `resolved` 规范化为公共源 `registry.npmjs.org`**。原先 301 条全部指向
  `registry.npmmirror.com` —— npm 只会在地址是**默认源**时才替换成用户配置的 registry,写死成第三方
  镜像后,在只放行自家私服的网络(例如内网 Nexus)里 `npm ci` 会直接失败。规范化后各人自己的
  `npm config set registry` 都能生效;本机实测仍走原镜像,安装耗时不变

### 新增

- **离线开发支持**:`npm run bundle:offline` 打出一个自包含的压缩包(源码 + npm 缓存 + 已构建产物
  + 驱动 jar + 说明),内网机器解包后 `npm ci --offline` 即可。另提供 `npm run doctor` 做环境体检。
  完整流程见 [docs/offline.md](docs/offline.md)

## [0.2.0] - 2026-09-23

### 修复

- **`-- @connection` 指令不生效,且每次绑定都会多插一行**。扩展写入的是
  `-- @connection: 名称`(带冒号),而解析只认不带冒号的写法,于是指令永远解析不到 ——
  每次执行都会再问一次连接,每次回答都再插一行。两种写法现在都认,写入与解析放在同一处,
  并用往返测试钉住
- **「Run again」重跑的是该面板第一次执行的 SQL**。复用的面板没有更新回调,重跑处理器停留在
  面板创建时捕获的那条语句 —— 新建查询文件时就是模板里的 `SELECT 1`
- **从查询历史插入/删除完全没反应**。两个命令都用 `asNode()` 收窄参数,而历史条目没有
  `kind` 字段,于是拿到 `undefined` 后静默返回
- **导出结果时报「结果已不可用」**。桥在连接关闭或磁盘预算用尽后会丢弃缓存结果,而面板能活得
  比它久。现在遇到这种情况会重跑语句再导出,而不是丢一个死胡同给用户
- **保存脚本后执行按钮消失**。新建查询是 untitled 文档,存成非 `.sql` 文件名会被重新判定语言,
  `editorLangId == sql` 条件随之失效,连带快捷键和 SQL 补全一起消失。菜单改用扩展自己的上下文
  键(同时认带指令的文档),保存后若语言退化为纯文本则恢复为 SQL
- **结果网格滚动时不断重绘导致难以滚动**。每帧重建 tbody 会改变表格高度,可能再触发滚动事件,
  渲染自己喂自己。现在记住已渲染的窗口,窗口未变就不重建;表头高度改为重建时测量一次,
  行位置不再偏移
- **连接模板的用户覆盖真正生效了**。文件里一直写着"可以把副本放到
  `<globalStorage>/templates/connection-templates.json`,按 `id` 合并",但代码从未读过那个路径 ——
  是"打算这么做"被当成"已经这么做"写进了文档。现在实现了,并支持用 `disabled` 移除内置条目

### 新增

- **取 DDL 的 SQL 可以自己写**(`ddl.queries`)。很多数据库本来就能直接给出建表语句,而且比"从 JDBC
  元数据重建"更准 —— 重建看不到存储子句、表空间、引擎选项,也看不到驱动报成 `OTHER` 的类型。规则按连接
  URL 的 glob 匹配,第一条命中生效;没有命中才回到内置重建,所以默认行为不变。示例:
  `DESC ${qualified}`(Hive)、`SELECT pg_get_tabledef('${qualified}')`(PostgreSQL)、
  `SHOW CREATE TABLE ${quotedQualified}`(MySQL)。结果按数据库返回的样子展示:单单元格开成文本,
  否则开结果网格
- **占位符显式区分原始名与加引号名**。这是必须的而不是洁癖:`pg_get_tabledef('${quotedQualified}')`
  会去找一张**名字里带引号**的表 —— 不报语法错,只是找不到。现在 `${qualified}` 是原始名(用于字符串
  字面量、Hive 的 `DESC`),`${quotedQualified}` 才加引号。这个改动同时作用于自定义动作
- **自定义 SQL 动作**(`actions` 设置):在表、视图、列上按自己的模板跑 SQL。填不上的占位符会**阻止**
  执行而不是变成空串(`LIKE '%%'` 那种静默错配比直接拒绝危险得多);语句在已绑定连接的编辑器里打开,
  而不是静默执行
- **连接改用单页表单,带「测试联通」按钮**。必须测试通过才能保存:存一个连不上的连接,问题要到
  第一次查询时才暴露。测试走桥的独立探测通道(开完即关,不进连接池),所以测一个已经连着的连接
  不会干扰它。字段里的 JDBC URL 会随驱动选择自动预填(仅在为空时,不覆盖已填内容)
- **内置 DDL 生成器的风格选项**:`ddl.ifNotExists`、`ddl.indent`、`ddl.includeIndexes`、
  `ddl.quoteIdentifiers`。有规则匹配时这些不生效
- `query.maxRows`:可配置的取数行数上限(`0` 表示不限),命中上限会标记为截断
- **表树筛选**:按名称过滤表、视图、列、索引,生效时视图描述显示 `filter: 关键字`
- `result.openIn`:结果面板位置,默认 `below`(上下分屏)
- **每条 SQL 上方的 Run 按钮**(code lens),可用 `query.codeLens` 关闭
- **脚本参数变量**:`${V_DATE}` 形式的占位符,打开脚本时下方自动弹出参数面板,
  执行前替换;变量样式可用 `variables.pattern` 自定义正则。有变量未填值则拒绝执行并指出是哪个

## [0.1.1] - 2026-09-22

**扩展的行为与 0.1.0 完全相同。** 这一版只修正了随包发布的文档,并让构建产物可复现。
如果你已经在用 0.1.0,从功能角度看没有升级的必要。

发这一版的原因是:0.1.0 的 VSIX 是从 tag 所在提交构建的,而下面这些文档修正发生在那之后,
所以 `v0.1.0` 里那份 `README.md` 是旧的。

### 修复

- README 列出的连接模板与实际不符:删去并不存在的 ClickHouse,补上遗漏的 MariaDB 与 GaussDB
- README 把命令面板的调用路径写成 `Open DB Client: ...`,而命令实际贡献在 `DB Client` 分类下,
  用户照着输是找不到的
- README 里本地打包的产物名漏了版本号

### 新增(仅开发,不影响扩展行为)

- `scripts/check-docs.mjs`: 校验 README 中的设置名、命令面板标签、快捷键、视图、链接锚点与
  CHANGELOG 小节是否与 `package.json` 一致,并接入 `npm test`。这类错误不会让构建失败,
  但用户一用就会撞上
- 打包 `bridge.jar` 时不再用构建时刻作为 ZIP 条目时间戳,改用提交时间(CI 经
  `SOURCE_DATE_EPOCH` 传入)。这样时间戳不再是变量,同一个 JDK 下重建即可得到相同的 jar

### 一致性说明

下面是**直接下载两个 Release 的 VSIX 逐项比对**得到的结论,不是估计:

| 文件 | 与 0.1.0 的关系 |
|---|---|
| `out/extension.js` | 逐字节相同 |
| `media/result/main.js` | 逐字节相同 |
| `resources/bridge.jar` | 83 个条目内容完全相同;仅 ZIP 条目时间戳不同(0.1.0 未固定时间戳) |
| `README.md` | 有差异 —— 这正是本版存在的理由 |

关于 jar 的可复现性:它以**同一个 JDK** 为前提。用不同版本的 javac 编译,生成的字节码并不保证
一致 —— 实测用 JDK 21 重建 0.1.1,时间戳可以完全对上,但类文件字节与 `Created-By` 行都不同。

## [0.1.0] - 2026-09-22

首个版本。

### 新增

**连接**

- 通过用户自备的 JDBC 驱动连接任意数据库,不绑定数据库类型
- 驱动获取:从 Maven Central 按坐标下载 / 添加本地 jar / 指向已有目录
- 驱动发现读取 jar 内的 `META-INF/services/java.sql.Driver`,也支持手动指定驱动类名
- 连接管理:新建、编辑、复制、删除、测试、连接、断开;连接池可在重新连接时复用
- 密码存入 VS Code `SecretStorage`
- 连接模板(MySQL / PostgreSQL / openGauss / Oracle / SQL Server / ClickHouse / Hive /
  SQLite / Transwarp / Custom),只预填 URL 前缀与驱动类名,不含方言逻辑
- 通过状态栏或 `-- @connection <名称>` 注释指令把 SQL 文件绑定到连接
- 数据库树:目录 → schema → 表/视图 → 列/索引,单层结构自动折叠

**查询**

- 执行选中内容、光标处语句或整个文件;支持一次执行多条语句
- 破坏性语句执行前二次确认
- 长查询可取消(调用 `Statement.cancel()` 真正下发到数据库)
- 结果集不经过进程间通信:桥直接落盘,界面按 200 行一页读取,支持虚拟滚动
- 值转换:超大整数与 `BigDecimal` 转字符串避免精度丢失,超长文本截断,二进制显示为占位符
- 磁盘结果缓存按 LRU 淘汰,默认上限 512 MiB
- 查询历史,保留最近 500 条,可插回编辑器

**SQL 智能补全**

- 表名补全与列名补全,支持别名/表名限定
- `INSERT INTO t (` 处补列而非补表
- 关键字与代码片段补全
- 补全在扩展进程内计算,不消耗 IPC 往返;元数据按需加载并 LRU 缓存

**导出**

- 四种格式:CSV(CRLF + 可选 UTF-8 BOM)、JSON、Excel `.xlsx`、`INSERT` 语句
- 可从查询结果导出,也可不查询直接导出整张表
- xlsx 手写 OOXML,支持大表自动拆多 sheet,不引入 Apache POI
- 导出不设行数上限;写失败时删除半成品文件

**表结构**

- 查看列(类型、长度、可空、默认值、注释)与索引(是否唯一)
- 根据元数据生成 `CREATE TABLE` 语句

**健康监控**

- 状态栏实时显示连接数与堆占用
- Markdown 健康报告:JVM 堆/线程/运行时长、每个连接的池借还情况、运行中查询数、
  结果缓存占用与淘汰数、已加载驱动
- 指标仅来自 JDK JMX,不依赖任何第三方库,也不采集数据库服务端指标

### 说明

- Java 桥零外部依赖,由 `javac` + `jar` 直接构建(无需 Maven/Gradle),产物约 144 KiB
- 不实现任何数据库方言;跨库行为差异通过 JDBC 能力探测(`DatabaseMetaData` /
  `supportsXxx()`)处理
- 代码中不含任何驱动 jar

### 已知限制

- SQL 补全不做子查询与 CTE 作用域
- 结果网格只读,不能在网格内编辑数据
- 不支持 SSH 隧道
- 健康监控不含数据库服务端指标

[0.2.0]: https://github.com/livebug/open-dbclient/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/livebug/open-dbclient/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/livebug/open-dbclient/releases/tag/v0.1.0
