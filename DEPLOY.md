# 部署到公网

`npm start` 跑出来的 `localhost` / 局域网地址只能自己人测试。要让群里的人点开就能玩，需要一个公网 HTTPS 地址。

> **当前线上地址**：由 WorkBuddy 应用托管发布，链接形如
> `https://<子域名>/`，访问时需要带上平台发放的访问码参数 `?sharecode=xxxx`。
> 页面会把访问码记在 `localStorage` 里，之后生成的房间邀请链接（`/r/房间码`）会自动带上同一个访问码，
> 所以直接把「分享到群里」的链接发出去即可，群友不需要自己拼参数。
> 注意邀请链接不要手工截掉 `?sharecode=`，否则新访客会被网关挡在「链接不完整」页面。

这个项目没有任何第三方依赖，代码里也没有写死的域名：静态资源全部用相对路径，页面里的分享图地址会按访问域名自动补成绝对地址。所以三种主流做法都能直接用。

| 方式 | 适合谁 | 成本 | 稳定性 |
| --- | --- | --- | --- |
| Render 免费实例 | 想几分钟上线、不想买服务器 | 免费 | 会休眠，地址固定 |
| Railway / Zeabur / Fly.io | 已经在用这些平台 | 按量计费或有免费额度 | 好 |
| 自己的 VPS + 域名 | 想长期跑、要自己的域名 | 域名 + 服务器 | 最好 |

---

## 方式一：Render（推荐，最快）

### 1. 把代码推到 GitHub

在 GitHub 上新建一个空仓库（不要勾选 README / .gitignore），然后在项目目录执行：

```bash
git init
git add .
git commit -m "ouqi-duel"
git branch -M main
git remote add origin https://github.com/你的用户名/ouqi-duel.git
git push -u origin main
```

### 2. 在 Render 里建服务

- 打开 <https://dashboard.render.com> → **New** → **Blueprint**
- 选中刚才的仓库 → **Apply**
- Render 会自动读根目录的 `render.yaml`（Node 22、`node server.mjs`、健康检查 `/api/health`）

如果 Blueprint 不认这个文件，也可以走 **New → Web Service** 手动填：

| 配置项 | 值 |
| --- | --- |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node server.mjs` |
| Health Check Path | `/api/health` |

端口不用管，Render 会通过 `PORT` 环境变量注入，服务已经读过这个变量。

### 3. 拿到地址

部署完成后是 `https://ouqi-duel-xxxx.onrender.com`。打开首页 → 创建房间 → 复制邀请链接，格式是：

```text
https://ouqi-duel-xxxx.onrender.com/r/房间码
```

把这个链接发到群里就行。

### 免费实例的注意事项

- **15 分钟没人访问会休眠**，下次打开要等 30–60 秒冷启动。开局前先在群里说一声，或者自己提前点一下链接预热。
- **房间数据在内存里**，重新部署、休眠被回收都会清空正在进行的对局。
- 只能单实例运行。免费层本来就是一个实例，不用管；如果你以后开了多实例，房间会分散在不同实例上，需要换 Redis 存状态。

---

## 方式二：Railway / Zeabur / Fly.io

这些平台能直接识别 `Dockerfile`：

```bash
docker build -t ouqi-duel .
docker run -p 3000:3000 -e TRUST_PROXY=1 ouqi-duel
```

在平台上把仓库连上去，构建方式选 Dockerfile，容器端口填 `3000` 即可。平台一般会自动注入 `PORT`，偶尔要求你手动指定，填 `3000`。

`TRUST_PROXY=1` 的作用见下面「真实客户端 IP」一节。Docker Compose 示例：

```yaml
services:
  ouqi-duel:
    build: .
    ports:
      - "3000:3000"
    environment:
      TRUST_PROXY: "1"
    restart: unless-stopped
```

---

## 方式三：自己的服务器 + 域名

服务器装好 Node.js 20+，把代码放上去，用 systemd 托管：

```ini
# /etc/systemd/system/ouqi-duel.service
[Unit]
Description=ouqi-duel
After=network.target

[Service]
WorkingDirectory=/opt/ouqi-duel
ExecStart=/usr/bin/node server.mjs
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=TRUST_PROXY=1
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ouqi-duel
```

前面挂一层 Caddy，HTTPS 证书自动申请：

```caddyfile
duel.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

用 Nginx 的话核心是这两行：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`HOST=127.0.0.1` 让 Node 只监听本机，由反向代理对外，比直接暴露 3000 端口安全。因为直连方变成了内网地址，服务会自动信任转发头，不写 `TRUST_PROXY=1` 也能拿到真实 IP。

---

## 真实客户端 IP

服务对「创建房间」「加入房间」做了限流。放在反向代理后面时，Node 看到的连接地址是代理的地址，如果直接拿来限流，全群会共用一个配额，13 个人同时进房就会被挡住。

现在的处理方式是：

- 如果直连方是内网地址（本机、Docker 网桥、云平台内部代理），就信任 `X-Forwarded-For` / `CF-Connecting-IP`，取真实客户端 IP；
- 如果公网用户直连 3000 端口，就不信任这些头，防止伪造请求头绕过限流；
- 拿不准时可以显式设置 `TRUST_PROXY=1`。

## 部署后检查清单

- [ ] `https://你的域名/api/health` 返回 `{"ok":true,...}`
- [ ] 首页能打开，创建房间后跳转到 `/r/房间码`
- [ ] 换一台手机、用 4G 打开邀请链接，能进同一个房间
- [ ] 把链接发到 QQ / 微信，卡片能抓到标题和预览图
- [ ] 手机浏览器里 `Ctrl/Cmd + R` 或重新打开，仍在原房间（靠 `localStorage` 里的 token）

## 常见问题

**打开 502 / Bad Gateway**
进程没起来或者端口不对。先看平台日志里有没有 `欧气对决已启动`，再确认服务监听的是 `process.env.PORT`，不要写死端口。

**打开很慢**
免费实例在休眠，冷启动要几十秒。付费实例或者自己的服务器没这个问题。

**群里分享没有预览图**
分享图地址是 `/og.png`，微信 / QQ 的抓取器对相对地址支持不稳，服务已经根据 `Host` / `X-Forwarded-Host` 自动补成绝对地址。如果还是没有，通常是平台没传 `X-Forwarded-Host`，或者微信缓存了旧卡片——换个路径参数（例如 `?v=2`）能强制刷新。

**进房提示「操作有点频繁」**
说明多个人的请求被当成了同一个 IP，检查反向代理有没有传 `X-Forwarded-For`，必要时设置 `TRUST_PROXY=1`。

**想要固定房间码 / 长期排行榜**
房间状态在 Node 进程内存里，休息时会清空。要长期运营需要把 `rooms` 换成 Redis，并保持单实例或按房间分片。

**国内访问 Render 慢**
Render 的节点在海外，国内直连可能偏慢。可以套一层 Cloudflare（顺便缓存静态资源），或者换成国内云厂商的服务器 + 已备案域名。
