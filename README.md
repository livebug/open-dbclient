# Open DB Client

[![CI](https://github.com/livebug/open-dbclient/actions/workflows/ci.yml/badge.svg)](https://github.com/livebug/open-dbclient/actions/workflows/ci.yml)
[![Release](https://github.com/livebug/open-dbclient/actions/workflows/release.yml/badge.svg)](https://github.com/livebug/open-dbclient/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC.svg)](https://code.visualstudio.com/)

> A universal JDBC database client for VS Code: connect, SQL completion, execute, export, table
> structure and JDBC-level health monitoring — without being tied to any particular database.

用 JDBC 连接**任意**数据库的 VS Code 客户端:连接、SQL 智能补全、执行、导出、表结构、健康监控。

它**不绑定任何数据库**:不写 `if (mysql) ... else if (oracle) ...`,只走 JDBC 标准 API 加能力探测。
驱动由你自己提供,想连什么就放什么 jar。

```mermaid
flowchart LR
    A["VS Code 扩展<br/>(TypeScript)"] -- "NDJSON / stdio" --> B["Java 桥<br/>java -jar bridge.jar"]
    B -- "Driver.connect()" --> C["你自备的<br/>JDBC 驱动 jar"]
    C --> D[("数据库")]
    B -. "大结果集落盘<br/>按页读取" .-> E["临时文件"]
```

---

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [准备 JDBC 驱动](#准备-jdbc-驱动)
- [快速上手](#快速上手)
- [功能详解](#功能详解)
- [命令与快捷键](#命令与快捷键)
- [配置项](#配置项)
- [架构与设计取舍](#架构与设计取舍)
- [安全说明](#安全说明)
- [从源码开发](#从源码开发)
- [已知限制](#已知限制)
- [发布流程](#发布流程)
- [许可](#许可)

---

## 环境要求

| 项目 | 要求 | 说明 |
|---|---|---|
| VS Code | **1.90.0** 或更高 | |
| JDK | **17** 或更高 | 只需要 JRE 能跑 `java` 即可;桥本身零外部依赖 |

扩展会在启动桥时自动寻找 `java`。如果 PATH 里没有,或者要用指定版本,请设置
`open-dbclient.javaHome` 或 `JAVA_HOME`。

---

## 安装

### 方式一:从 GitHub Release 下载(推荐)

1. 打开 [Releases](https://github.com/livebug/open-dbclient/releases) 页面
2. 下载最新的 `open-dbclient-<版本>.vsix`
3. 在 VS Code 中按 `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → 选择该文件

命令行等价写法:

```
code --install-extension open-dbclient-0.1.0.vsix
```

### 方式二:从源码构建安装

见[从源码开发](#从源码开发)。

> 本扩展尚未发布到 VS Code 应用市场,请使用上面两种方式之一。

---

## 准备 JDBC 驱动

**本扩展不含任何驱动 jar。** 请通过以下任一方式提供:

### 方式一:从 Maven Central 下载(最省事)

`Ctrl+Shift+P` → **DB Client: Download Driver from Maven Central...**,然后按
`groupId:artifactId:version` 输入坐标,例如:

```
org.postgresql:postgresql:42.7.4
com.mysql:mysql-connector-j:9.1.0
org.xerial:sqlite-jdbc:3.47.1.0
com.microsoft.sqlserver:mssql-jdbc:12.8.1.jre11
```

### 方式二:添加本地 jar

`Ctrl+Shift+P` → **DB Client: Add Driver Jar...**,选中的 jar 会被复制到扩展的驱动目录。

### 方式三:直接丢进驱动目录

`Ctrl+Shift+P` → **DB Client: Open Driver Folder**,把 jar 拷进去,然后
**DB Client: Restart JDBC Bridge**(或重载窗口)。

### 方式四:用设置指向已有目录

不想复制文件的话,在 `settings.json` 里直接指向现有目录:

```jsonc
{
  // 目录或单个 jar 文件,支持 ~ 开头,最多 200 个
  "open-dbclient.driverPaths": ["~/jdbc-drivers", "/opt/vendor/lib/foo-driver.jar"],

  // 可选:明确指定驱动类名。一般不需要,扩展会从 jar 里读 META-INF/services/java.sql.Driver
  "open-dbclient.driverClassNames": ["com.vendor.jdbc.Driver"]
}
```

加载了哪些驱动可以用 **DB Client: List Loaded Drivers** 查看。

---

## 快速上手

### 1. 建一个连接

点活动栏的 **Open DB Client** 图标 → 点 **Connections** 视图标题栏的 `+`,然后按提示依次输入:

```
连接类型    ← 选择内置模板(MySQL / MariaDB / PostgreSQL / openGauss / GaussDB /
             Apache Hive / Hive 兼容(如 Transwarp Inceptor)/ SQL Server / Oracle /
             SQLite / Custom)
连接名称    ← 自己起一个好记的名字
主机 / 端口 / 数据库
用户名
密码        ← 存入 VS Code 加密的 SecretStorage,不落明文
自定义参数  ← 可留空,格式 key=value;key=value
```

模板只做两件事:预填 JDBC URL 前缀和驱动类名。它**不是方言** —— 选 MySQL 模板不等于
扩展会为 MySQL 走特殊代码路径。

### 2. 打开查询并执行

- 命令面板 → **DB Client: New Query**,或者
- 直接在任意 `.sql` 文件里用(需要先把文件关联到连接,见下)

| 快捷键 | 行为 |
|---|---|
| `Ctrl+Enter` / `Cmd+Enter` | 执行选中内容;没有选中则执行光标所在的**单条**语句;都没有则执行整个文件 |
| `Ctrl+Shift+Enter` / `Cmd+Shift+Enter` | 执行整个文件里的**所有**语句 |

结果出现在右侧的网格面板,支持分页、导出、取消、重跑。

### 3. 把 SQL 文件绑定到连接

两种方式,任选其一:

- 状态栏左下角点连接名 → 命令面板选择 **Attach This File to a Connection**
- 在文件里写一行注释指令:

```sql
-- @connection 生产库只读

SELECT id, name FROM users WHERE created_at > '2026-01-01';
```

### 4. 写 SQL 时会有补全

```sql
SELECT * FROM ord|          -- 补全表名
SELECT u.|                  -- 补全 u 这个别名/表的所有列
SELECT * FROM users WHERE na|   -- 即使还没写 FROM 的表,有 alias 也能补列
INSERT INTO users (|        -- 补全列名
```

补全数据来自 JDBC 元数据,连上就自动后台预取表名(可用
`open-dbclient.intellisense.prefetchTables` 关掉)。

---

## 功能详解

### 连接管理

- 连接、断开、测试、编辑、复制、删除;密码单独存 `SecretStorage`
- 连接池:默认每连接 1 条(设 `open-dbclient.connection.poolSize` 调整)
- 重新连接同名同目标的连接会**复用**连接池,不会泄漏
- 改密码后会自动重建连接
- 数据库树按 `目录 → schema → 表/视图 → 列/索引` 展开,单层结构会自动折叠

### SQL 智能补全

- 表名补全:`FROM` / `JOIN` / `INTO` / `UPDATE` / `USING` 之后
- 列名补全:带别名或表名限定时,只补该表的列
- 关键字与代码片段补全:`sel` `ins` `upd` `del` `joi` `cre` `wit`
- 补全逻辑跑在扩展进程内(**不走 IPC**),所以不占用每次按键的往返延迟
- 元数据按需加载并做 LRU 缓存(`intellisense.columnCacheLimit`)

### 执行

- 支持多条语句,执行前会自动剥离注释(块注释支持嵌套)
- `INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE` 等破坏性语句默认二次确认
  (`open-dbclient.query.confirmDangerous`)
- 长查询可取消:取消按钮 + **DB Client: Cancel Running Query**
  (`Statement.cancel()` 真的会打到数据库,不是只丢结果)
- 单次查询最多取 `100000` 行,超出会被标记截断

### 结果网格

- 虚拟滚动:几十万行也不卡(界面每页 200 行,按需从磁盘拉)
- 单元格值:超过 64 KiB 截断显示;大于 2^53 的整数与 `BigDecimal` **转成字符串**避免精度丢失;
  二进制显示为 `[blob N bytes...]`
- 结果集**不经过 IPC**:桥直接落盘成临时文件,内存占用有上限
  (`open-dbclient.result.maxCacheBytes`,默认 512 MiB,SIG 会按 LRU 淘汰最旧的)

### 表结构与 DDL

- **Show Columns**: 列名、类型、长度、是否可空、默认值、注释
- **Show Indexes**: 索引名、列、是否唯一
- **Generate DDL**: 根据元数据生成 `CREATE TABLE` 语句

### 导出

四种格式,不设行数上限(为了能整表导出):

| 格式 | 说明 |
|---|---|
| **CSV** | CRLF 换行,可选 UTF-8 BOM(默认开;Excel 没 BOM 时按本地码页解析,中文会乱码) |
| **JSON** | 对象数组,保留类型 |
| **Excel (.xlsx)** | 超大数据自动拆多 sheet;字符串按 inline 写入,不需要全量内存 |
| **INSERT 语句** | 可直接搬到别的库执行;数值列上为保精度而存成字符串的值会**不加引号**输出 |

两个入口:**导出查询结果**(Export Result)和**直接导出整张表**(Export Table,不用先查一遍)。
写文件失败时会删除半成品文件。

### JDBC 健康监控

状态栏实时显示桥的连接数/堆占用;点击或运行 **DB Client: Show JDBC Health** 打开
Markdown 报告,包含:

- 桥进程:JVM 堆使用、线程数、运行时长
- 连接池:每个连接的 `total / idle / checkedOut` 与借用时长
- 查询与结果:运行中查询数、缓存的结果集数量与占用、被淘汰数量
- 驱动:已加载的 jar 与驱动类

> 监控**只覆盖 JDBC 层与桥进程自身**,不含数据库服务端指标 —— 那需要各家的私有 SQL,和
> 「零方言」的前提冲突。

### 查询历史

- 每次执行都记录到 **Query History** 视图(SQL、连接、耗时、行数、成功与否)
- 保留最近 500 条,JSONL 存储
- 可插入回编辑器、单条删除、清空

---

## 命令与快捷键

按 `Ctrl+Shift+P` 输入 `DB Client` 可以看到全部命令。

| 命令 | 说明 |
|---|---|
| **连接** | |
| Add / Edit / Duplicate / Delete Connection | 增改复制删连接 |
| Test Connection | 只测连通性,不建立池 |
| Connect / Disconnect | 连接与断开 |
| Attach This File to a Connection | 把当前 SQL 文件绑到某连接 |
| **查询** | |
| New Query | 新建 SQL 编辑并绑定连接 |
| Run Query | 执行选中 / 光标处语句 / 整个文件 |
| Run All Queries | 执行整个文件所有语句 |
| Cancel Running Query | 取消正在跑的查询 |
| Select Top 200 Rows | 从树上直接预览表数据 |
| **导出** | |
| Export Result... | 导出当前结果网格 |
| Export Table... | 不查询,直接导出整张表 |
| **表结构** | |
| Show Columns / Show Indexes / Generate DDL | 列、索引、建表语句 |
| Copy Name | 复制节点名 |
| **驱动** | |
| Add Driver Jar... / Open Driver Folder | 添加本地驱动 |
| Download Driver from Maven Central... | 按坐标下载驱动 |
| List Loaded Drivers | 查看已加载驱动 |
| **其它** | |
| Show JDBC Health | 打开健康报告 |
| Restart JDBC Bridge | 重启 Java 桥 |
| Refresh Metadata Cache / Refresh / Refresh All | 刷新缓存与树 |
| Query History 相关 | 插入 / 删除 / 清空历史 |

快捷键:

| 快捷键 | 命令 | 生效条件 |
|---|---|---|
| `Ctrl+Enter` / `Cmd+Enter` | Run Query | SQL 文件且已绑定连接 |
| `Ctrl+Shift+Enter` / `Cmd+Shift+Enter` | Run All Queries | 同上 |

---

## 配置项

全部位于 `open-dbclient.*`。

### Java 与驱动

| 设置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `javaHome` | string | `""` | JDK 目录;留空则自动查找 |
| `javaArgs` | array | `[]` | 传给桥进程的额外 JVM 参数 |
| `jvmMaxHeap` | string | `"1g"` | 桥进程的 `-Xmx` |
| `driverPaths` | array | `[]` | 额外的驱动目录或 jar 路径 |
| `driverClassNames` | array | `[]` | 强制指定的驱动类名 |

### 连接与查询

| 设置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `connection.poolSize` | number | `1` | 每个连接的池大小 |
| `query.fetchSize` | number | `200` | JDBC fetch size |
| `query.confirmDangerous` | boolean | `true` | 破坏性语句执行前确认 |
| `result.maxCacheBytes` | number | `536870912` | 磁盘结果缓存上限(512 MiB),超出按 LRU 淘汰 |

### 智能补全

| 设置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `intellisense.enabled` | boolean | `true` | 总开关 |
| `intellisense.prefetchTables` | boolean | `true` | 连接后后台预取表名 |
| `intellisense.columnCacheLimit` | number | `500` | 列信息缓存的表数量上限 |

### 健康监控

| 设置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `health.enabled` | boolean | `true` | 总开关 |
| `health.refreshInterval` | number | `2000` | 刷新间隔(毫秒,最小 500) |
| `health.showStatusBar` | boolean | `true` | 是否显示状态栏 |

### 导出与日志

| 设置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `export.csv.delimiter` | string | `","` | CSV 分隔符 |
| `export.csv.writeBom` | boolean | `true` | CSV 是否写 UTF-8 BOM |
| `export.excel.maxRowsPerSheet` | number | `1048576` | xlsx 单 sheet 行数上限 |
| `export.includeHeader` | boolean | `true` | 是否输出表头 |
| `logLevel` | string | `"info"` | 桥日志级别 |

---

## 架构与设计取舍

```
VS Code 扩展进程 (TypeScript)            Java 桥进程 (零依赖)
├── 连接/查询/导出 编排                    ├── 驱动加载   (URLClassLoader)
├── 树视图、结果 webview                   ├── 连接池     (自研)
├── SQL 补全      ← 本地计算,不走 IPC      ├── 元数据读取 (DatabaseMetaData)
└── 健康监控      ←─ NDJSON over stdio ──→ ├── 查询执行   (分页/取消/落盘)
                                          ├── 导出       (CSV/JSON/SQL/XLSX)
                                          └── JMX 指标
```

**为什么用外挂 Java 进程而不是纯 Node?**

JDBC 是 Java 的东西。要在 Node 里连任意数据库,得为每个数据库引一个原生驱动包 —— 那就违背了
「驱动由用户自备、不绑定数据库」的前提。桥进程让「任意 JDBC 驱动」这件事原样成立。

**为什么桥是零依赖的?**

用户的驱动 jar 常常是含 shade 的 fat jar,自己带着一堆库。桥一旦也引入 HikariCP、POI 之类,
classpath 上的版本冲突就成了用户的问题。所以:连接池自己写,xlsx 自己写,JSON 编解码自己写。
代价是代码量,收益是 `bridge.jar` 只有约 144 KiB,且几乎不可能和任何驱动冲突。

**为什么不用方言?**

能力探测(`DatabaseMetaData.getIdentifierQuoteString()`、`supportsXxx()`)能回答绝大多数问题,
而且新数据库天然可用。方言层留到需要写数据库私有 SQL 时再说 —— 目前只有健康监控需要,而那部分
被明确划出了范围。

**其它几个取舍:**

| 决定 | 收益 | 代价 |
|---|---|---|
| 大结果集落盘、按页取,不跨 IPC | 内存不随结果集增长 | 需要临时文件与 LRU 淘汰 |
| 补全放在 TypeScript 侧 | 零 IPC 延迟 | 元数据缓存要在两边各维护一份 |
| 健康面板做成 Markdown 报告而非 webview | 白拿编辑器的选中/搜索/复制,代码量极小 | 不能画图表 |
| 连接表单用多步快速输入而非 webview 表单 | 命令面板可用、远程会话可用、代码少 | 驱动自定义属性要手敲 `key=value` |

---

## 安全说明

- **密码存在 VS Code 的 `SecretStorage` 里**,不写进任何配置文件
- 连接档案(主机、端口、用户名等)存在扩展的 `globalStorage` 下的 JSON 文件里
- **权限提示**:任何能写这个 JSON 文件或能调用扩展命令的人,就相当于能连你配置的那些库 ——
  请按此评估共享机器上的使用
- 与数据库之间**没有网络监听端口**,扩展与桥通过子进程 stdio 通信
- 桥进程的日志打到 stderr,不会污染协议流

---

## 从源码开发

```bash
git clone https://github.com/livebug/open-dbclient.git
cd open-dbclient
npm install
```

### 构建

```bash
npm run compile         # 打包扩展与 webview → out/extension.js, media/result/main.js
npm run bridge:compile  # 编译 Java 桥      → resources/bridge.jar
npm run icon            # 重新生成扩展图标   → media/icon/icon.png
```

### 在 VS Code 里调试

用 VS Code 打开本仓库,按 `F5` 启动「Run Extension」,会新开一个装好了本扩展的窗口。

### 测试

```bash
npm test        # 类型检查 + 文档与清单一致性 + 30 项 Java 测试 + 24 项 SQL 测试(无需数据库)
npm run verify  # 上面全部 + 构建桥 + 冒烟检查
```

冒烟检查需要一个放了驱动的目录。不传目录时它会打印提示并**直接跳过**(退出码 0),
所以别把它当成跑过了 —— 想真正跑那 118 项检查要这样:

```bash
mkdir -p /tmp/dbclient-drivers && cd /tmp/dbclient-drivers
curl -O https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.47.1.0/sqlite-jdbc-3.47.1.0.jar
curl -O https://repo1.maven.org/maven2/org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar

cd - && npm run smoke -- /tmp/dbclient-drivers
```

这里用 Node 24 自带的 `node:sqlite` 造 fixture 库,不需要装任何数据库。

`scripts/check-docs.mjs` 会校验 README 里写的设置名、命令面板标签、快捷键、视图和链接是否
真的存在 —— 这些都是不会让构建报错、但用户一用就撞上的错误。

### 目录结构

```
bridge/src/main/java/com/opendbclient/bridge/
├── json/       手写 JSON 编解码(NaN、大整数、代理对都处理了)
├── rpc/        NDJSON 协议:并发派发、串行写入、取消、错误分类
├── conn/       驱动加载、连接注册表、能力探测
├── pool/       自研连接池
├── metadata/   表/列/索引读取 + DDL 生成
├── result/     值转换、结果落盘、分页
├── export/     CSV / JSON / INSERT / XLSX
├── health/     JMX 指标
└── handler/    RPC 方法实现

src/
├── bridge/     桥进程客户端(帧解析、请求关联、Java 探测、进程生命周期)
├── model/      连接档案与存储
├── driver/     驱动发现/下载
├── service/    连接、元数据、导出、历史、模板
├── sql/        SQL 上下文分析与补全
├── tree/       连接树、历史树
├── webview/    结果网格面板
├── commands/   命令注册
└── util/       日志、SQL 语句切分、虚拟文档
```

---

## 已知限制

- **没有方言层**。全部走标准 JDBC;某个数据库的私有语法、私有元数据、`\d` 之类的元命令都不支持
- **健康监控不含数据库服务端指标**(连接数上限、锁等待、复制延迟等),只覆盖 JDBC 层与桥进程
- **SQL 补全不做子查询 / CTE 作用域**,别名解析只在当前语句的顶层生效
- **结果网格只读**,不能直接在网格里改数据
- **不支持 SSH 隧道**(可以用本地端口转发绕过)
- 驱动由用户自备,**扩展不校验驱动与目标数据库是否匹配**

路线图(未承诺):数据编辑、SSH 隧道、方言层、应用市场发布。

---

## 发布流程

发版是**打 tag 即自动完成**的:

```bash
# 1. 更新版本号与 CHANGELOG
npm version 0.2.0 --no-git-tag-version

# 2. 提交
git add -A && git commit -m "chore: release 0.2.0"

# 3. 打 tag 并推送 —— 这一步会触发自动发版
git tag v0.2.0
git push origin main --tags
```

推 tag 之后,`.github/workflows/release.yml` 会自动:

1. 装 Node 24 与 JDK 17
2. `npm ci` → 类型检查 → Java 单元测试 → SQL 测试
3. 构建桥与扩展,用 `vsce package` 打出 `.vsix`
4. 在 GitHub 上创建 Release,把 `open-dbclient-<版本>.vsix` 作为附件挂上去

tag 名必须是 `v` 开头的语义化版本(`v0.2.0`)。发布产物里的版本号取自
`package.json`,所以**先改 `package.json` 再打 tag**;workflow 会校验两者一致,不一致直接失败。

手动打包(本地):

```bash
npm run package                                    # 先跑测试,再打包
npm run package -- --no-verify                     # 跳过测试,只打包
# → build/open-dbclient-0.1.0.vsix
```

---

## 许可

[MIT](LICENSE)
