# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/),格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
- 桥的 `bridge.jar` 现在可复现:打包时用提交时间(CI 经 `SOURCE_DATE_EPOCH` 传入)而不是构建
  时刻作为 ZIP 条目的时间戳,因此可以重建某个 tag 来校验发布产物

### 一致性说明

已逐项核对,不是估计:

- `out/extension.js` 与 `media/result/main.js` 与 0.1.0 **逐字节相同**
- `resources/bridge.jar` 的 **83 个条目内容与 0.1.0 完全相同**,差异只在 ZIP 条目时间戳

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

[0.1.1]: https://github.com/livebug/open-dbclient/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/livebug/open-dbclient/releases/tag/v0.1.0
