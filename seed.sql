-- ============================================================================
-- AutoManage Toledo - Dados Iniciais (Seed Data)
-- Extraído diretamente da base consolidada Toledo_v2 (data.js)
-- ============================================================================

-- 1. SOCIEDADES
INSERT INTO sociedades (id, nome, descricao) VALUES
(1, 'Lagoa', 'Parceria e comissão em sociedade para compra/venda de veículos');

-- 2. CATEGORIAS DE DESPESA
INSERT INTO categorias_despesa (id, nome, descricao) VALUES
(1, 'Mecânica', 'Manutenção mecânica, motor, câmbio, injeção'),
(2, 'Peças e Acessórios', 'Reposição de peças, chaves, calotas, filtros'),
(3, 'Estética', 'Higienização interna, polimento, lavagem detalhada'),
(4, 'Comissão / Sociedade', 'Comissão paga a parceiros ou intermediários'),
(5, 'Funilaria e Pintura', 'Reparos de lataria, para-choques e pintura'),
(6, 'Documentação', 'Vistorias cautelares, taxas Detran, ATPV e despachante'),
(7, 'Pneus', 'Substituição, conserto, alinhamento e balanceamento'),
(8, 'Transporte e Guincho', 'Serviço de frete, guincho e translado');

-- 3. CLIENTES / COMPRADORES
INSERT INTO clientes (id, nome, telefone) VALUES
(1, 'Cliente Toledo', '(11) 98765-4321'),
(2, 'Cristina', '(19) 99123-4567'),
(3, 'Nelson', '(19) 99876-1122'),
(4, 'Cliente Particular', '(19) 98111-2233');

-- 4. VEÍCULOS
INSERT INTO veiculos (id, marca, modelo, ano, placa, renavam, chassis, observacoes, cor, combustivel, cambio, km, sociedade_id, antigo_dono, data_compra, valor_compra, valor_fipe, status, foto_url) VALUES
(1, 'Fiat', 'Toro Endurance 2.0 Turbo Diesel', 2022, 'RTM 9G72', NULL, NULL, NULL, 'Cinza Granite', 'Diesel', 'Automático', 42000, NULL, 'Uai Veiculos', '2026-09-03', 74900.00, 101000.00, 'Vendido', 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=800&q=80'),
(2, 'Renault', 'Sandero 1.6 8V Expression', 2014, 'EZP 6E22', NULL, NULL, NULL, 'Prata', 'Flex', 'Manual', 118000, NULL, 'Uai Veiculos', '2026-09-03', 16900.00, 32000.00, 'Vendido', 'https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?auto=format&fit=crop&w=800&q=80'),
(3, 'Hyundai', 'HB20 1.0 Comfort Plus', 2015, 'FXL 5I69', NULL, NULL, NULL, 'Branco Polar', 'Flex', 'Manual', 89000, NULL, 'Suellin', '2026-09-08', 33000.00, 50000.00, 'Vendido', 'https://images.unsplash.com/photo-1590362891991-f776e747a588?auto=format&fit=crop&w=800&q=80'),
(4, 'BMW', 'X1 sDrive20i 2.0 Turbo', 2013, 'EQN 1J10', NULL, NULL, NULL, 'Preto Safira', 'Gasolina', 'Automático', 98000, NULL, 'Giuseppe Maset', '2026-09-18', 33500.00, 74000.00, 'Em estoque', 'https://images.unsplash.com/photo-1555215695-3004980ad54e?auto=format&fit=crop&w=800&q=80'),
(5, 'Volkswagen', 'Gol 1.0 Total Flex', 2012, 'GTO 7G79', NULL, NULL, NULL, 'Branco', 'Flex', 'Manual', 135000, 1, 'Uai Veículos', '2026-09-29', 19900.00, 28990.00, 'Em estoque', 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80'),
(6, 'Chevrolet', 'Onix LT 1.0 Prata Flex', 2019, 'QQD 9C35', NULL, NULL, NULL, 'Prata Switchblade', 'Flex', 'Manual', 67000, 1, 'Uai Veículos', '2026-09-29', 34900.00, 53937.00, 'Em preparação', 'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=800&q=80'),
(7, 'Chevrolet', 'Astra Sedan 2.0 Advantage', 2008, 'EBM 7E53', NULL, NULL, NULL, 'Prata', 'Flex', 'Manual', 145000, NULL, 'Nelson de Souza Silva', '2026-10-02', 18000.00, 29900.00, 'Vendido', 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=800&q=80'),
(8, 'Honda', 'CB 250F Twister', 2018, 'QIU 0B54', NULL, NULL, NULL, 'Vermelho Rally', 'Flex', 'Manual', 26000, 1, 'Diogenes de Souza Araujo', '2026-10-03', 11000.00, 16900.00, 'Em estoque', 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=800&q=80');

-- 5. DESPESAS
INSERT INTO despesas (id, veiculo_id, categoria_id, data_despesa, item, valor) VALUES
(1, 1, 1, '2026-09-10', 'Remap Ney', 2000.00),
(2, 1, 2, '2026-09-10', 'Reservatório de água', 100.00),
(3, 1, 1, '2026-09-10', 'Reparo da bomba de vácuo', 100.00),
(4, 1, 3, '2026-09-15', 'Higienização completa e polimento', 500.00),
(5, 1, 4, '2026-09-25', 'Comissão para Lagoa', 5000.00),
(6, 1, 1, '2026-10-01', 'Revisão e acerto final', 2500.00),
(7, 2, 1, '2026-09-10', 'Peças para retífica do cabeçote', 250.00),
(8, 2, 3, '2026-09-10', 'Higienização interna', 500.00),
(9, 2, 7, '2026-09-15', 'Substituição de pneus', 200.00),
(10, 2, 2, '2026-09-22', 'Jogo de cabos de vela', 85.00),
(11, 3, 5, '2026-09-15', 'Funilaria Joel', 1500.00),
(12, 3, 6, '2026-09-26', 'Patrika Vistoria Cautelar', 220.00),
(13, 3, 3, '2026-09-26', 'Kevin Higienização', 500.00),
(14, 3, 7, '2026-09-28', 'Pneus', 260.00),
(15, 3, 6, '2026-09-29', 'Documentação e taxas', 621.00),
(16, 3, 2, '2026-10-01', 'Jogo de calotas', 45.80),
(17, 3, 7, '2026-10-01', 'Pneus / Conserto e alinhamento', 70.00),
(18, 3, 1, '2026-10-01', 'Relé e lâmpadas', 22.00),
(19, 3, 4, '2026-10-05', 'Comissão para Lagoa', 3845.00),
(20, 3, 1, '2026-10-05', 'Sensor de rotação', 71.00),
(21, 3, 1, '2026-10-05', 'Material elétrico e instalação', 97.04),
(22, 4, 8, '2026-09-17', 'Guincho e viagem (Pirassununga)', 1000.00),
(23, 4, 1, '2026-09-23', 'Filtro lub, anel pistão, jogo de juntas, filtro de ar e biela', 1362.96),
(24, 4, 2, '2026-09-23', 'Bronzina de biela', 245.00),
(25, 4, 2, '2026-10-01', 'Peças complementares', 245.00),
(26, 4, 1, '2026-10-04', 'Mão de obra e revisão', 400.00),
(27, 5, 7, '2026-09-30', 'Pneu dianteiro', 200.00),
(28, 6, 8, '2026-09-30', 'Guincho torto / Transporte', 1000.00),
(29, 6, 2, '2026-10-01', 'Chave codificada reserva', 350.00),
(30, 6, 1, '2026-10-02', 'Módulo eletrônico', 300.00),
(31, 6, 1, '2026-10-02', 'Fusíveis e chicote elétrico', 39.00),
(32, 6, 5, '2026-10-06', 'Para-choque dianteiro e traseiro', 633.00);

-- 6. DOCUMENTOS
INSERT INTO documentos (id, veiculo_id, tipo, link_arquivo, data_upload, observacao) VALUES
(1, 1, 'CRLV', 'https://drive.google.com/file/d/1W1LHjCCUqtgjcn_nkKkGcJwBy6uliQeU/view?usp=drive_link', '2026-09-14', 'CRLV Digital 2026 emitido e verificado'),
(2, 2, 'ATPV', 'ATPV SANDERO.pdf', '2026-09-14', 'Autorização para Transferência de Propriedade de Veículo assinada'),
(3, 3, 'Laudo Cautelar', 'https://drive.google.com/file/d/1EuWfmyyBK2JMQDXojVsm5M0HJX-gCQan/view?usp=drive_linkk', '2026-09-26', 'Laudo cautelar 100% aprovado sem apontamentos'),
(4, 3, 'Laudo Transferência', 'https://drive.google.com/file/d/1vVoZDFbQj7h3oyae4x3ye-jgX2LvBhBv/view?usp=drive_link', '2026-09-26', 'Vistoria Detran para transferência pronta'),
(5, 3, 'CRLV', 'https://drive.google.com/file/d/1T2G3FYgpwWVhxBbt29dgI-Hy7DUwcWt7/view?usp=drive_link', '2026-10-01', 'CRLV digital emitido para novo comprador Nelson'),
(6, 4, 'CRLV', 'https://drive.google.com/file/d/1HGKEV554gyggUrUU-OG16qcOXKPwavQu/view?usp=drive_link', '2026-09-17', 'CRLV BMW X1 2026'),
(7, 7, 'CRLV', 'https://drive.google.com/file/d/1NDPPjG-anPYcLCGk_HAXp52tnBf6O_UG/view?usp=drive_link', '2026-10-04', 'CRLV Astra 2026'),
(8, 8, 'CRLV', 'https://drive.google.com/file/d/1AtxRp-ZtSHiyDiuAWOKBwtAYPN56oLaC/view?usp=drive_link', '2026-10-04', 'CRLV Twister 2026');

-- 7. VENDAS
INSERT INTO vendas (id, veiculo_id, cliente_id, data_venda, valor_venda, tipo_pagamento, valor_entrada, num_parcelas, valor_parcela, quitado) VALUES
(1, 1, 1, '2026-09-24', 148500.00, 'Parcelado', 41000.00, 43, 2500.00, FALSE),
(2, 2, 2, '2026-09-25', 44000.00, 'Parcelado', 14000.00, 30, 1000.00, FALSE),
(3, 3, 3, '2026-10-02', 78000.00, 'Parcelado', 18000.00, 40, 1500.00, FALSE),
(4, 7, 4, '2026-10-03', 47000.00, 'Parcelado', 11000.00, 36, 1000.00, FALSE);

-- 8. PARCELAS / CARNÊ DE PAGAMENTOS
INSERT INTO pagamentos_parcelas (id, venda_id, veiculo_id, numero_parcela, data_vencimento, data_pagamento, valor_nominal, valor_pago, status, forma_pagamento, mes_ref, observacao) VALUES
(1, 1, 1, 1, '2026-09-25', '2026-09-25', 2500.00, 2500.00, 'pago', 'PIX', '2026-09', 'Pago na entrada/Setembro'),
(2, 1, 1, 2, '2026-10-25', NULL, 2500.00, NULL, 'pendente', NULL, '2026-10', NULL),
(3, 2, 2, 1, '2026-10-25', NULL, 1000.00, NULL, 'pendente', NULL, '2026-10', NULL),
(4, 3, 3, 1, '2026-11-02', NULL, 1500.00, NULL, 'pendente', NULL, '2026-11', NULL),
(5, 4, 7, 1, '2026-11-03', NULL, 1000.00, NULL, 'pendente', NULL, '2026-11', NULL);

