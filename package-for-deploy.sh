#!/bin/bash
# PDUMind - Package for Deployment
# Creates a deployment archive ready to transfer to another server

set -e
cd "$(dirname "$0")"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ARCHIVE_NAME="pdumind-deploy-${TIMESTAMP}.tar.gz"

echo "📦 Packaging PDUMind for deployment..."

# Create archive excluding unnecessary files
tar --exclude='node_modules' \
    --exclude='__pycache__' \
    --exclude='.git' \
    --exclude='*.pyc' \
    --exclude='.DS_Store' \
    --exclude='*.log' \
    --exclude='.env' \
    -czvf "../${ARCHIVE_NAME}" .

ARCHIVE_PATH="$(cd .. && pwd)/${ARCHIVE_NAME}"
ARCHIVE_SIZE=$(du -h "$ARCHIVE_PATH" | cut -f1)

echo ""
echo "✅ Archive created: ${ARCHIVE_PATH}"
echo "   Size: ${ARCHIVE_SIZE}"
echo ""
echo "📋 Next steps:"
echo "   1. Transfer archive to target server:"
echo "      scp ${ARCHIVE_PATH} user@server:/opt/"
echo ""
echo "   2. On target server, extract and configure:"
echo "      cd /opt && tar -xzvf ${ARCHIVE_NAME}"
echo "      cd PDUMind"
echo "      cp .env.example .env  # Then edit with your settings"
echo ""
echo "   3. Start the application:"
echo "      ./start.sh"
echo ""
echo "   Note: .env file is NOT included for security."
echo "         Create it on the target server."
