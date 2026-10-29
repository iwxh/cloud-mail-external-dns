# 客户保留 DNS 的部署教程

客户不交出域名账号、不改 NS。网站程序运行在你的一个 Cloudflare 账号；每个客户资源分开。

## 先核对旧邮箱

若客户已有根域 MX，不要运行迁移。部署器会停止。先商定原邮箱迁移、旧系统转发，或使用独立邮箱子域。
不能通过混填两家 MX 把不同用户名分配给不同服务商。

## 每客户一次配置

在本仓库 Settings → Environments 创建 `external-客户邮箱域名`，例如 `external-kinghh.cn`。
将部署分支限定 main，Required reviewers 选择你本人，并禁止管理员绕过审批。

Variables：

| 名称 | 填写内容 |
|---|---|
| CUSTOMER_DOMAIN | 客户邮箱域名，例如 kinghh.cn，不能填 mail.kinghh.cn，除非邮箱后缀就是 @mail.kinghh.cn |

Secrets：

| 名称 | 填写内容 |
|---|---|
| CLOUDFLARE_ACCOUNT_ID | 共用的 CF 账号 ID |
| CLOUDFLARE_API_TOKEN | 新仓库专用部署 Token，授权同一个 CF 账号的 Workers Scripts、D1、KV、Workers AI；不需要 DNS 编辑、Email Routing 或 CF 原生发信权限 |
| RESEND_API_KEY | 本客户单独配置的 Resend full_access Key，不使用旧项目的 Key；套餐需有新增域名及 Webhook 额度 |
| MAIL_OWNER_EMAIL | 由你或客户控制、接收管理员激活通知的邮箱 |

所有 Secret 都由本人在对应页面填写，不放进聊天、代码、截图、运行参数或工单。CF 部署 Token 只交给工作流，绝不进入客户 Worker。
客户 Worker 只保存自己的 JWT、Resend Key 和 Webhook 签名 Secret。

## 三个阶段

1. 打开 Actions → New external DNS mail customer → Run workflow，分支 main、输入域名，operation 先选 **plan**。它只读核对归属、已有 MX、服务商域名冲突，不创建资源。
2. 结果无冲突后选择 **prepare**，本人审批。创建 `xm-` 前缀的独立 Worker、D1、KV，在 Resend 注册新域名和签名通知，返回系统登录地址与 DNS 清单。此时尚未完成邮箱开通。
3. 将清单交客户填写：类型、完整名称、内容、MX 优先级以服务商实际返回值为准。部分 DNS 后台会自动补后缀，注意不要重复域名。已有 SPF/DMARC 需要核对，不重复添加或自动覆盖。原网站 A/AAAA/CNAME 保留。
4. 等解析生效后，在**同一个代码提交**上选择 **finish**，本人再次审批。程序检查两个公网解析器及 Resend 验证状态，再发送激活通知。Resend 认证是异步的，流程最多等待约 20 分钟；超时后可重试 finish，复用已有资源。若必需的收发信记录均已认证，可选 Forge CNAME 尚待认证导致的 Partially Verified 不会阻挡激活。
5. 到 MAIL_OWNER_EMAIL 查收激活码，打开运行摘要中的系统地址 `/setup`，填写完整 64 位激活码、12–30 字符密码和确认密码。
6. 登录管理员账号。登录框带后缀时只填 admin；无后缀时填完整邮箱。

## 验收与限制

- 从外部邮箱发邮件到管理员，确认正文、附件、内嵌图片和多收件人归属。
- 从正式网站发往 QQ/Gmail，确认实际收到，不能只看“接口成功”。
- 重放同一通知，收件箱记录不增加；其他客户的通知不能读入本客户。
- 首版原始邮件最大 20 MiB，超出返回错误并要求人工处理，不报告成功；单封附件数量上限 40。
- 自动转发首版保持关闭，需要后续单独适配。
- `workers.dev` 在部分网络可能访问不稳定；正式客户可用你管理的域名地址，或另做 SaaS 自定义域名接入。改域名时必须同步来源校验、证书与通知地址，不能只加 CNAME。

## 重试保护

prepare 重试必须使用同一源代码 SHA。已部署项目升级需要单独发布流程。
对于已上传且资源完整的项目，plan/finish 可以使用后续的部署流程修复版本，但必须证明原提交是当前提交的祖先，且 mail-worker、mail-vue 与初始化 schema 的 Git 内容完全一致；否则停止。这个例外不重新上传 Worker，也不更改资源归属或保存的原始源码版本。
Worker 归属、D1/KV 绑定、数据库标识不一致时停止；已有未知资源、已有服务商域名不自动接管。
初始化中断且已存在应用表时停止人工检查，不清库。
JWT 已存在则不轮换；已激活管理员不重置密码。未激活 finish 重试生成新码，旧码失效。
首次资源创建后、进度保存前中断可能留下空资源，需要人工核对；不按名字强行接管或自动删除。

本仓库不连接旧项目的 CF Git 构建，也不继承原仓库 Secrets。共用 CF 账号的额度和账单仍会互相占用，请按客户统计使用量。

## 已有项目的收信兼容修复

首版收信下载使用了 `redirect: 'error'`。Cloudflare Workers 只支持 `manual` 和 `follow`，因此会在发出请求前报错。修复版使用 `manual` 并拒绝非成功响应，仍然禁止自动跳转，也不会向邮件原文下载地址发送 API Key。

已经上线的项目不会因为 main 更新而自动发版。如需修复，选择 Actions → **Repair existing external mail inbound**，输入已有客户域名及部署状态记录中的完整 40 位源码 SHA，经客户环境本人审批后运行。程序仅接受 `mail-worker/src/external/protocol.js` 这一处运行代码变动，并核对仓库、账号、客户、Worker、数据库、KV、加密密钥、通知接口与已激活数据库标识。该流程不创建资源、不执行初始化、不改密码、密钥、DNS 或服务商配置。上线后仍须进行真实收信与附件验收。

## 增加 mail.客户域名 登录地址

客户保留外部 DNS 时，自定义网页登录地址需要先通过 Cloudflare for SaaS 接入并验证 HTTPS 证书。普通 CNAME 到 workers.dev 不能代替这一步。使用你自己在 CF 托管的接入域名，并将路由限定到对应客户；不要用全站通配路由覆盖现有网站或邮箱。

在 Actions 选择 **Add external mail website hostname**，输入已有邮箱域名、`mail.邮箱域名` 和部署状态记录中当前完整 40 位源码 SHA，再本人审批客户环境。该流程只增加该项目的网页域名支持，保留原 workers.dev 地址和 Resend 签名通知接口；收信通知仍只在原地址接收。数据库、邮件、账号、密码和加密密钥继续使用现有资源，不执行初始化。

完成 SaaS 接入后，在客户 DNS 平台按实际返回值添加 `mail` CNAME 及必要的验证记录。原 MX、SPF、DKIM、网站 A/AAAA/CNAME 和 NS 保留。运行摘要中的 `website_runtime_ready_dns_tls_pending` 只表示程序适配完成，还必须验收新域名的证书、登录、附件、真实收发信。

此流程当前仅支持精确的 `mail.邮箱域名`，不接受任意网址、通配符或其他客户域名。它是已有项目的受保护手动流程，不会在 push main 时自动给旧项目发版。
