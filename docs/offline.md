# 内网离线开发指南

给需要把本项目带到**没有互联网**的环境里做二次开发的人。全流程约十分钟。

---

## 先说结论:只有一步需要联网

我实测过 —— 把 npm registry 和 HTTP 代理全部指向一个死端口(确认 `npm view` 确实失败),然后跑完整流程:

| 步骤 | 联网时 | 断网时 |
|---|---|---|
| `npm ci` | ✅ | ❌ **只有这一步** |
| `npm test`(类型检查 + 文档检查 + 39 项 Java 测试 + 106 项 TS 测试) | ✅ | ✅ |
| `npm run smoke -- <驱动目录>`(125 项端到端检查) | ✅ | ✅ |
| `npm run bridge:compile`(Java 桥构建) | ✅ | ✅ |
| `npm run package`(打 VSIX) | ✅ | ✅ |

原因是这个项目的 Java 桥**零外部依赖**,直接用 `javac` + `jar` 构建,**不需要 Maven**;扩展侧的所有依赖都在 `node_modules` 里,构建时不再下载任何东西。

所以离线方案的核心只有一句话:**把 `npm ci` 需要的 tarball 带进去。**

---

## 一、在有网的机器上打包

```bash
cd open-dbclient
npm run bundle:offline -- --drivers /path/to/jdbc-drivers
```

产出 `build/open-dbclient-offline-<版本>-<平台>.tar.gz`,约 **40 MB**,内含:

| 目录 | 内容 |
|---|---|
| `source/` | HEAD 提交的完整源码(`git archive`,所以是提交而不是工作区) |
| `npm-cache/` | 支撑 `npm ci --offline` 的 npm 缓存,约 31 MB |
| `prebuilt/` | 已构建好的 `bridge.jar` 与 webview bundle,可以先跑起来再决定要不要自己构建 |
| `drivers/` | 用 `--drivers` 指定时带进来的 JDBC 驱动 jar,供离线跑端到端检查 |
| `OFFLINE.md` | 本文档 |
| `MANIFEST.txt` | 版本、提交号、构建平台、工具链版本、关键产物的 sha256 |

> **缓存不跨平台。** npm 缓存里只有当前平台的二进制(esbuild 会按平台装不同的包),所以在 Windows 上打的包拿到 Linux 上用不了。**要在与目标机器相同 OS/CPU 架构的机器上打包**;如果目标有多种平台,每种打一份。

别忘了另外单独准备两样东西(体积大,不适合塞进包里):

- **JDK 17 或更高**(只需要能跑 `java` / `javac` / `jar`)
- **VS Code 安装包**(如果目标机器也没有)

---

## 二、在内网机器上开始

### 0. 先做体检

```bash
node scripts/offline-doctor.mjs
```

它会检查 Node / npm / JDK / git 是否齐备、版本够不够,并给出缺什么、去哪里找。**先跑这一步**,比构建失败后再排查省事。

### 1. 解包并安装依赖

```bash
tar -xzf open-dbclient-offline-0.2.0-linux-x64.tar.gz
cd source

# 用包里的缓存离线安装,不访问任何网络
npm ci --offline --cache ../npm-cache
```

如果这里报 `ENOTCACHED`,说明缓存缺了东西 —— 基本只有两种原因:平台不匹配(见上),或者 `package-lock.json` 在打包之后被改过。

### 2. 验证环境

```bash
npm test          # 类型检查 + 文档一致性 + Java 测试 + TS 测试,不需要数据库
```

想跑端到端检查(需要驱动 jar):

```bash
npm run smoke -- ../drivers
```

### 3. 构建与调试

```bash
npm run compile         # 扩展与 webview → out/extension.js, media/*/main.js
npm run bridge:compile  # Java 桥 → resources/bridge.jar
```

在 VS Code 里打开 `source/`,按 `F5` 启动「Run Extension」调试。

### 4. 打包并安装

```bash
npm run package            # → build/open-dbclient-<版本>.vsix
code --install-extension build/open-dbclient-0.2.0.vsix
```

或在 VS Code 里 `Ctrl+Shift+P` → **Extensions: Install from VSIX...**。

### 5. 换成内网私服(可选,但建议)

`package-lock.json` 里的 `resolved` 已经**全部规范化为公共源 `registry.npmjs.org`**。这一点是刻意的:

npm 取包时用的是 `resolved` 里记的地址,**但只有当地址是默认源时才替换成你配置的 registry**。所以写成默认源,各人自己的 `npm config set registry` 就能生效 —— 无论你走公共源、公司私服还是内网 Nexus。反过来,如果 lockfile 被写死成某个第三方镜像(这个仓库曾经就是这样,301 条全指向 `registry.npmmirror.com`),那在只放行自家私服的网络里 `npm ci` 会直接失败。

内网私服只需要:

```bash
npm config set registry https://nexus.内网域名/repository/npm-group/
npm ci    # 有网时;没网就用 --offline --cache
```

`npm run docs` 会校验 lockfile 里没有非默认源的地址,防止悄悄回退。

---

## 三、内网里哪些功能用不了

### 运行时:从 Maven Central 下载驱动

命令面板里的 **DB Client: Download Driver from Maven Central...** 会访问
`https://repo1.maven.org/maven2`,内网必然失败。

**替代做法**:提前把驱动 jar 拷进驱动目录,或用「**Open Driver Folder**」打开该目录放进去。

驱动目录位置(`<globalStorage>` 由 VS Code 决定):

| 平台 | 路径 |
|---|---|
| Linux | `~/.config/Code/User/globalStorage/open-dbclient.open-dbclient/drivers/` |
| Windows | `%APPDATA%\Code\User\globalStorage\open-dbclient.open-dbclient\drivers\` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/open-dbclient.open-dbclient/drivers/` |

放好后运行 **DB Client: Restart JDBC Bridge**,再用 **List Loaded Drivers** 确认加载成功。

也可以不改文件,直接在 `settings.json` 里指向任意已有目录:

```jsonc
{
  "open-dbclient.driverPaths": ["/opt/jdbc-drivers"],
  "open-dbclient.driverClassNames": ["com.vendor.jdbc.Driver"]  // 一般不需要
}
```

> 扩展**不内置任何驱动 jar**,也不校验驱动与目标库是否匹配 —— 这一点在内网里反而更省事。

### CI:GitHub Actions 工作流

`.github/workflows/` 下的两个工作流在内网跑不了,而且 `release.yml` 还会从
`repo1.maven.org` 下载 sqlite 驱动。**内网不需要它们** —— 本地命令已经覆盖了同样的检查。

如果要接内网 GitLab CI,直接照搬本地命令即可:

```yaml
build:
  script:
    - npm ci --offline --cache "$NPM_CACHE"
    - npm test
    - npm run bridge:compile
    - npm run package
  artifacts:
    paths: [build/*.vsix]
```

### 开发期:集成测试框架

`devDependencies` 里的 `@vscode/test-electron` 会下载 VS Code 测试运行时,内网用不了。目前项目里**还没有集成测试用到它**,所以不影响;如果以后要加,需要在内网自建一个下载源或改用本地 VS Code 安装。

---

## 四、内网二开的建议配置

如果内网有这些基础设施,可以让日常开发更顺:

| 设施 | 用途 | 常见选择 |
|---|---|---|
| 私有 npm 源 | 以后要加新依赖时不必再打包 | Verdaccio、Nexus、cnpm |
| 私有 Maven 源 | 集中管理 JDBC 驱动 jar | Nexus |
| 私有 Git | 承载这个仓库 | GitLab、Gitea |
| 内部镜像/制品库 | 存放内网版 VSIX 与 JDK | 任意制品库 |

**一个务实的顺序**:先按上面三步把项目跑起来(不需要任何基础设施),等真要加新依赖时再建私有 npm 源 —— 因为只要不动依赖,`npm ci --offline` 永远够用。

---

## 五、二开时容易踩的地方

这些是项目里刻意做的约定,改动时值得先知道:

| 约定 | 原因 | 相关位置 |
|---|---|---|
| **Java 桥零外部依赖** | 用户的驱动 jar 常常是 fat jar 自带一堆库,桥再引库就会撞版本 | 新增 Java 依赖前先想清楚;真需要时用 `bridge/src/main/java` 下的自研实现 |
| **不写方言分支** | 跨库差异靠 JDBC 能力探测(`getIdentifierQuoteString()` / `supportsXxx()`),新库天然可用 | 想加"某个库特殊处理"时,先看能否用 `DatabaseCapabilities` 表达 |
| **写入端与解析规则必须同处** | `-- @connection` 曾经因为写 `:` 而读不带 `:`,导致指令完全失效 | `src/constants.ts` 里 `CONNECTION_DIRECTIVE` 与 `connectionDirective()` 挨着放,并有往返测试 |
| **可选字段缺省,不要用空串** | 占位符展开成空串会得到"能跑但结果错"的 SQL | `buildActionContext` 里 `column` 就是缺省而非空串 |
| **改了设置就要改文档** | README 里的设置名/命令名/版本号都会被自动校验 | `npm run docs` 会拦下来 |
| **版本号与 CHANGELOG 必须同步** | 发版脚本按 tag 与 `package.json` 一致性校验 | `scripts/extract-changelog.mjs` |

改完代码务必跑:

```bash
npm test                                        # 不需要数据库
npm run smoke -- /path/to/jdbc-drivers          # 需要驱动 jar
```

---

## 六、发内网版本

内网不需要走 GitHub Release。直接:

```bash
npm version 0.2.1-internal.1 --no-git-tag-version   # 内网可以带后缀,便于区分
# 更新 CHANGELOG.md 加对应版本小节(否则 npm test 会失败)
npm test && npm run package
# 把 build/open-dbclient-<版本>.vsix 放进内部制品库
```

注意 `release.yml` 会校验 **tag 名必须等于 `v` + `package.json` 版本**,内网如果沿用这套工作流要保证一致;不走工作流就无所谓。
