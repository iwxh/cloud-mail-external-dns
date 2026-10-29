# Cloud Mail：客户保留原 DNS

独立产品仓库，基于 [iwxh/cloud-mail](https://github.com/iwxh/cloud-mail) 的稳定版本 `ec506cc2884415ce01b3ba8af3033efaf92a4506`。保留原项目 MIT 许可证。

本仓库与原仓库没有自动同步、部署或资源共享关系。共用一个 Cloudflare 账号，每个客户有独立 Worker、D1、KV、JWT 和运行时密钥。
网站在 Cloudflare，邮件通过 Resend 收发。部署程序只生成客户需要填写的解析清单，**不修改任何域名的 DNS、NS、CF Email Routing 或旧 Worker**。

## 使用前

- 当前为新增功能的开发验收版；离线测试和打包通过不等于真实收发验收通过。首个测试域名：`kinghh.cn`。
- 默认使用系统分配的 `workers.dev` 登录地址，邮箱后缀仍为客户域名。
- 客户要求 `mail.客户域名` 登录时，需要额外部署 Cloudflare for SaaS 自定义主机名与证书路由。此版本不会把任意 CNAME 当成已经完成域名绑定。
- Resend 的域名数、Webhook 数和收发邮件额度受套餐限制。一个客户一个 Webhook。不会自动购买套餐或删除旧域名腾额度。
- 同一 CF 账号仍共享套餐配额和账单。独立资源不等于独立账号；账号管理员有权管理所有客户。
- Resend 收信 API 需要 full_access；独立命名的 Key 在同一 Resend 团队内仍有团队级权限。需要提供商权限也完全隔离时，为客户使用独立 Resend 团队，并将其 Key 放入该客户环境。禁止把旧生产项目的 Key 复制过来。

完整操作见 [EXTERNAL-DNS-DEPLOY.md](EXTERNAL-DNS-DEPLOY.md)。

## 一次开发，多次部署

1. 为客户准备 GitHub Environment：`external-example.com`，只允许 main，开启本人审批、禁止管理员绕过。
2. 添加变量 `CUSTOMER_DOMAIN=example.com`，以及该环境的四个 Secrets。
3. Actions → **New external DNS mail customer**，分支 main，域名 example.com，先选 plan。
4. 审阅只读结果，再选 prepare 创建该客户资源并生成解析清单。
5. 客户在原 DNS 平台填写清单，不切换 NS；已有企业邮箱先安排迁移。
6. 同一源代码提交上运行 finish，核对双公网 DNS 和服务商认证，发送激活通知。
7. 管理员自行设置密码，再做外部收信、网站发信、附件验证。

普通提交只运行测试和打包，**不会自动上线任何客户**。新建流程不是老项目升级工具。

## 本地检查

使用 Node 24、pnpm 9.10：

```sh
node --experimental-vm-modules --test automation/test/external-*.test.mjs
pnpm --dir mail-worker install --frozen-lockfile
pnpm --dir mail-vue install --frozen-lockfile
pnpm --dir mail-vue run build
node automation/external-check-bundle.mjs
```

收信通知有签名和时间窗口校验；在读取正文前按签名通知里的收件域名隔离。正文和附件通过官方 API 获取，附件保存成功后，邮件和附件引用以 D1 事务一起提交；重复通知不会重复创建收件箱记录。密送收件人不从原始 To/Cc/Received 头推测，不会将伪造的头部当作投递指令。

原项目的 CF 收信入口仍作为上游源码保留，但本产品入口不导出 CF email 事件，且拒绝 email 发信绑定。未验签的旧状态回调及旧初始化入口也不可访问。

首版自动转发暂未接入新通道，默认关闭；不要将原 CF message.forward 当作外部通道可用功能。QQ“代发”的实际表现仍需针对新邮件验证。
