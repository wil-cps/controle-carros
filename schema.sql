-- ============================================================================
-- AutoManage Toledo - Schema Relacional SQL
-- Sistema de Gestão de Estoque, Despesas, Vendas e Parcelamento Automotivo
-- Compatível com: PostgreSQL, MySQL 8+, SQLite, MariaDB
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABELA DE SOCIEDADES / PARCEIROS (Ex: "Lagoa")
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sociedades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL UNIQUE,
    descricao VARCHAR(255),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 2. TABELA DE CATEGORIAS DE DESPESA
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias_despesa (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL UNIQUE,
    descricao VARCHAR(255)
);

-- ----------------------------------------------------------------------------
-- 3. TABELA DE CLIENTES / COMPRADORES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(150) NOT NULL,
    telefone VARCHAR(30),
    cpf_cnpj VARCHAR(20),
    email VARCHAR(150),
    cidade VARCHAR(100),
    uf VARCHAR(2),
    observacoes TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 4. TABELA DE VEÍCULOS (ESTOQUE)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS veiculos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    marca VARCHAR(60) NOT NULL,
    modelo VARCHAR(120) NOT NULL,
    ano SMALLINT NOT NULL,
    placa VARCHAR(10) NOT NULL UNIQUE,
    renavam VARCHAR(20) NULL,
    chassis VARCHAR(30) NULL,
    cor VARCHAR(40),
    combustivel VARCHAR(30) DEFAULT 'Flex',
    cambio VARCHAR(30) DEFAULT 'Manual',
    km INT DEFAULT 0,
    sociedade_id INT NULL,
    antigo_dono VARCHAR(150),
    data_compra DATE NOT NULL,
    valor_compra DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    valor_fipe DECIMAL(12, 2) DEFAULT 0.00,
    status VARCHAR(30) NOT NULL DEFAULT 'Em estoque' 
        CHECK (status IN ('Em estoque', 'Em preparação', 'Vendido')),
    observacoes TEXT NULL,
    foto_url VARCHAR(500),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_veiculos_sociedade FOREIGN KEY (sociedade_id) 
        REFERENCES sociedades(id) ON DELETE SET NULL
);

-- ----------------------------------------------------------------------------
-- 5. TABELA DE DESPESAS DE VEÍCULOS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS despesas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    veiculo_id INT NOT NULL,
    categoria_id INT NULL,
    data_despesa DATE NOT NULL,
    item VARCHAR(255) NOT NULL,
    valor DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    comprovante_url VARCHAR(500),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_despesas_veiculo FOREIGN KEY (veiculo_id) 
        REFERENCES veiculos(id) ON DELETE CASCADE,
    CONSTRAINT fk_despesas_categoria FOREIGN KEY (categoria_id) 
        REFERENCES categorias_despesa(id) ON DELETE SET NULL
);

-- ----------------------------------------------------------------------------
-- 6. TABELA DE DOCUMENTOS, LAUDOS E FOTOS (REPOSITÓRIO DIGITAL)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documentos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    veiculo_id INT NOT NULL,
    tipo VARCHAR(60) NOT NULL, -- CRLV, ATPV, Laudo Cautelar, Laudo Transferência, Fotos, Contrato, etc.
    origem VARCHAR(20) DEFAULT 'upload' CHECK (origem IN ('upload', 'camera', 'link')),
    nome_arquivo VARCHAR(255) NULL,
    tamanho_bytes INT DEFAULT 0,
    tipo_mime VARCHAR(100) NULL,
    link_arquivo VARCHAR(500) NOT NULL, -- Caminho local no repositório ou URL em nuvem
    conteudo_base64 LONGTEXT NULL,      -- Storage do binário/base64 da foto ou PDF quando aplicável
    data_upload DATE NOT NULL,
    observacao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_documentos_veiculo FOREIGN KEY (veiculo_id) 
        REFERENCES veiculos(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 7. TABELA DE VENDAS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    veiculo_id INT NOT NULL UNIQUE, -- 1 venda ativa por veículo
    cliente_id INT NOT NULL,
    data_venda DATE NOT NULL,
    valor_venda DECIMAL(12, 2) NOT NULL,
    tipo_pagamento VARCHAR(30) NOT NULL DEFAULT 'Parcelado' 
        CHECK (tipo_pagamento IN ('À Vista', 'Parcelado', 'Financiamento Bancário')),
    valor_entrada DECIMAL(12, 2) DEFAULT 0.00,
    num_parcelas SMALLINT DEFAULT 0,
    valor_parcela DECIMAL(12, 2) DEFAULT 0.00,
    quitado BOOLEAN DEFAULT FALSE,
    data_quitacao DATE NULL,
    valor_quitacao_total DECIMAL(12, 2) NULL,
    observacoes TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_vendas_veiculo FOREIGN KEY (veiculo_id) 
        REFERENCES veiculos(id) ON DELETE CASCADE,
    CONSTRAINT fk_vendas_cliente FOREIGN KEY (cliente_id) 
        REFERENCES clientes(id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 8. TABELA DE PARCELAS / CARNÊ DE PAGAMENTOS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagamentos_parcelas (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    venda_id INT NOT NULL,
    veiculo_id INT NOT NULL,
    numero_parcela SMALLINT NOT NULL,
    data_vencimento DATE NOT NULL,
    data_pagamento DATE NULL,
    valor_nominal DECIMAL(12, 2) NOT NULL,
    valor_pago DECIMAL(12, 2) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pendente' 
        CHECK (status IN ('pendente', 'pago', 'atrasado', 'cancelado')),
    forma_pagamento VARCHAR(50) NULL, -- PIX, Dinheiro, Boleto, etc.
    mes_ref VARCHAR(7) NOT NULL,      -- AAAA-MM (Ex: 2026-09)
    observacao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_parcelas_venda FOREIGN KEY (venda_id) 
        REFERENCES vendas(id) ON DELETE CASCADE,
    CONSTRAINT fk_parcelas_veiculo FOREIGN KEY (veiculo_id) 
        REFERENCES veiculos(id) ON DELETE CASCADE,
    CONSTRAINT uq_venda_parcela UNIQUE (venda_id, numero_parcela)
);

-- ----------------------------------------------------------------------------
-- ÍNDICES PARA ALTA PERFORMANCE
-- ----------------------------------------------------------------------------
CREATE INDEX idx_veiculos_status ON veiculos(status);
CREATE INDEX idx_veiculos_placa ON veiculos(placa);
CREATE INDEX idx_veiculos_renavam ON veiculos(renavam);
CREATE INDEX idx_veiculos_chassis ON veiculos(chassis);
CREATE INDEX idx_despesas_veiculo ON despesas(veiculo_id);
CREATE INDEX idx_documentos_veiculo ON documentos(veiculo_id);
CREATE INDEX idx_vendas_veiculo ON vendas(veiculo_id);
CREATE INDEX idx_vendas_cliente ON vendas(cliente_id);
CREATE INDEX idx_parcelas_venda ON pagamentos_parcelas(venda_id);
CREATE INDEX idx_parcelas_status_vencimento ON pagamentos_parcelas(status, data_vencimento);
CREATE INDEX idx_parcelas_mesref ON pagamentos_parcelas(mes_ref);

-- ============================================================================
-- VIEWS DE NEGÓCIO (CÁLCULOS AUTOMÁTICOS DO SISTEMA)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- View 1: Resumo Financeiro Completo por Veículo (Despesas, Custo Final e Lucro)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_veiculos_financeiro AS
SELECT 
    v.id AS veiculo_id,
    v.marca,
    v.modelo,
    v.ano,
    v.placa,
    v.renavam,
    v.chassis,
    v.observacoes,
    v.status,
    s.nome AS sociedade,
    v.valor_compra,
    COALESCE(d.total_despesas, 0.00) AS total_despesas,
    (v.valor_compra + COALESCE(d.total_despesas, 0.00)) AS custo_final,
    v.valor_fipe,
    vn.id AS venda_id,
    vn.data_venda,
    c.nome AS comprador,
    c.telefone AS telefone_comprador,
    COALESCE(vn.valor_venda, 0.00) AS valor_venda,
    vn.valor_entrada,
    vn.num_parcelas,
    vn.valor_parcela,
    CASE 
        WHEN v.status = 'Vendido' AND vn.valor_venda IS NOT NULL 
        THEN (vn.valor_venda - (v.valor_compra + COALESCE(d.total_despesas, 0.00)))
        ELSE 0.00 
    END AS lucro_realizado
FROM veiculos v
LEFT JOIN sociedades s ON v.sociedade_id = s.id
LEFT JOIN (
    SELECT veiculo_id, SUM(valor) AS total_despesas
    FROM despesas
    GROUP BY veiculo_id
) d ON v.id = d.veiculo_id
LEFT JOIN vendas vn ON v.id = vn.veiculo_id
LEFT JOIN clientes c ON vn.cliente_id = c.id;

-- ----------------------------------------------------------------------------
-- View 2: Situação do Financiamento / Carnê por Veículo Vendido
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_financiamentos_status AS
SELECT 
    vn.id AS venda_id,
    v.id AS veiculo_id,
    CONCAT(v.marca, ' ', v.modelo) AS veiculo,
    v.placa,
    c.nome AS cliente,
    vn.valor_venda,
    vn.valor_entrada,
    vn.num_parcelas,
    vn.valor_parcela,
    COUNT(p.id) AS parcelas_geradas,
    COUNT(CASE WHEN p.status = 'pago' THEN 1 END) AS parcelas_pagas,
    COUNT(CASE WHEN p.status = 'pendente' THEN 1 END) AS parcelas_pendentes,
    COALESCE(SUM(CASE WHEN p.status = 'pago' THEN p.valor_pago ELSE 0 END), 0.00) AS total_recebido,
    COALESCE(SUM(CASE WHEN p.status = 'pendente' THEN p.valor_nominal ELSE 0 END), 0.00) AS saldo_devedor,
    CASE 
        WHEN COUNT(CASE WHEN p.status = 'pendente' THEN 1 END) = 0 AND COUNT(p.id) > 0 THEN 'QUITADO'
        ELSE 'EM ABERTO'
    END AS situacao_carne
FROM vendas vn
JOIN veiculos v ON vn.veiculo_id = v.id
JOIN clientes c ON vn.cliente_id = c.id
LEFT JOIN pagamentos_parcelas p ON vn.id = p.venda_id
GROUP BY vn.id, v.id, v.marca, v.modelo, v.placa, c.nome, vn.valor_venda, vn.valor_entrada, vn.num_parcelas, vn.valor_parcela;

-- ----------------------------------------------------------------------------
-- View 3: KPIs do Dashboard Geral
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_dashboard_kpis AS
SELECT 
    (SELECT COUNT(*) FROM veiculos WHERE status != 'Vendido') AS veiculos_em_estoque,
    (SELECT COALESCE(SUM(custo_final), 0.00) FROM vw_veiculos_financeiro WHERE status != 'Vendido') AS valor_total_estoque,
    (SELECT COUNT(*) FROM veiculos WHERE status = 'Vendido') AS total_vendidos,
    (SELECT COALESCE(SUM(valor_venda), 0.00) FROM vendas) AS total_vendas_valor,
    (SELECT COALESCE(SUM(lucro_realizado), 0.00) FROM vw_veiculos_financeiro WHERE status = 'Vendido') AS lucro_total_realizado,
    (SELECT COALESCE(SUM(valor), 0.00) FROM despesas) AS total_despesas_acumuladas,
    (SELECT COUNT(*) FROM despesas) AS qtd_despesas;

