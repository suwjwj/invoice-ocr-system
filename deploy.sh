#!/bin/bash
# ============================================================
#  票据智能识别系统 - 一键部署脚本 (Ubuntu/Debian)
#  用法: bash deploy.sh
# ============================================================

set -e

APP_DIR="/opt/invoice-ocr-system"
SERVICE_NAME="invoice-ocr"
PORT=8000

echo "========================================="
echo "  票据智能识别系统 - 一键部署"
echo "========================================="

# 1. 系统依赖
echo "[1/6] 安装系统依赖..."
apt update -y
apt install -y python3 python3-pip python3-venv git nginx

# 2. 克隆代码（如果还没有）
if [ ! -d "$APP_DIR" ]; then
    echo "[2/6] 克隆代码..."
    git clone https://github.com/suwjwj/invoice-ocr-system.git "$APP_DIR"
else
    echo "[2/6] 更新代码..."
    cd "$APP_DIR" && git pull
fi

cd "$APP_DIR"

# 3. 安装 Python 依赖
echo "[3/6] 安装 Python 依赖..."
pip3 install -r requirements.txt
pip3 install gunicorn

# 4. 创建数据目录
echo "[4/6] 初始化数据目录..."
mkdir -p data/uploads data/sroie/data/img data/sroie/data/key

# 5. 创建 systemd 服务
echo "[5/6] 配置系统服务..."
cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SERVICEEOF'
[Unit]
Description=Invoice OCR System
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/invoice-ocr-system
ExecStart=/usr/bin/gunicorn backend.api:app -w 1 -k uvicorn.workers.UvicornWorker -b 127.0.0.1:8000 --timeout 300
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

# 6. 配置 Nginx（如果 1Panel 没配的话）
echo "[6/6] 配置 Nginx..."
cat > /etc/nginx/sites-available/${SERVICE_NAME} << 'NGINXEOF'
server {
    listen 80;
    server_name _;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }
}
NGINXEOF

# 如果 sites-enabled 目录存在则创建软链
if [ -d /etc/nginx/sites-enabled ]; then
    ln -sf /etc/nginx/sites-available/${SERVICE_NAME} /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
fi

nginx -t && systemctl reload nginx

echo ""
echo "========================================="
echo "  部署完成！"
echo "========================================="
echo "  访问地址: http://$(curl -s ifconfig.me 2>/dev/null || echo '你的服务器IP'):80"
echo "  服务状态: systemctl status ${SERVICE_NAME}"
echo "  查看日志: journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "  如果用 1Panel，跳过 Nginx 配置，"
echo "  直接在 1Panel 网站管理中添加反向代理"
echo "  指向 127.0.0.1:${PORT} 即可"
echo "========================================="
