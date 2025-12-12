#!/bin/bash

# Script para limpiar sesión de Baileys en Railway

echo "🧹 Limpiando sesión de WhatsApp..."

# Eliminar carpeta de autenticación
rm -rf auth_info_baileys

echo "✅ Sesión limpiada. Reinicia el servidor para generar una nueva sesión."
