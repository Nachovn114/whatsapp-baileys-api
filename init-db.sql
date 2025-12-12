-- Script para inicializar la base de datos de Baileys
-- Ejecuta este SQL en tu base de datos PostgreSQL en Railway

CREATE TABLE IF NOT EXISTS auth_data (
    session_id VARCHAR(255) NOT NULL,
    data_key VARCHAR(255) NOT NULL,
    data_value TEXT,
    PRIMARY KEY (session_id, data_key)
);

-- Crear índice para mejorar performance
CREATE INDEX IF NOT EXISTS idx_session_id ON auth_data(session_id);

-- Verificar que la tabla se creó
SELECT 'Tabla auth_data creada exitosamente' AS status;
