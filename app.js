/**
 * AutoManage Toledo - Lógica Principal da Aplicação
 * Conexão com a base da planilha Excel Toledo_v2 e suporte completo a CRUD,
 * cálculos automáticos, gráficos e persistência local.
 */

// Captura de erros globais para debug
window.onerror = function (message, source, lineno, colno, error) {
  console.error(`[AutoManage Error] ${message} | Linha: ${lineno}:${colno}`, error);
  return false;
};

window.addEventListener('unhandledrejection', function (event) {
  console.error('[AutoManage Promise Error]', event.reason);
});

// Chave do LocalStorage
const DB_STORAGE_KEY = 'automanage_toledo_db_v1';
const THEME_STORAGE_KEY = 'automanage_toledo_theme';

// Estado global da aplicação
let appData = {
  veiculos: [],
  despesas: [],
  documentos: [],
  pagamentos: []
};

let currentDetailCarId = null;
let currentPaymentsYear = 2026;
let currentInventoryView = 'cards'; // 'cards' ou 'table'
let chartLucroInstance = null;
let chartCategoriasInstance = null;

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadDatabase();
  initApp();
});

function initTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem(THEME_STORAGE_KEY, newTheme);
  updateThemeIcon(newTheme);
  // Redesenhar gráficos para ajustar cores se necessário
  if (chartLucroInstance) renderDashboardCharts();
}

function updateThemeIcon(theme) {
  const icon = document.getElementById('themeIcon');
  if (!icon) return;
  if (theme === 'light') {
    icon.innerHTML = `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;
  } else {
    icon.innerHTML = `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`;
  }
}

function loadDatabase() {
  const stored = localStorage.getItem(DB_STORAGE_KEY);
  if (stored) {
    try {
      appData = JSON.parse(stored);
    } catch (e) {
      console.error('Erro ao ler LocalStorage, carregando padrão:', e);
      appData = JSON.parse(JSON.stringify(DEFAULT_DATABASE));
      saveDatabase();
    }
  } else {
    // Carregar dados originais da planilha
    appData = JSON.parse(JSON.stringify(DEFAULT_DATABASE));
    saveDatabase();
  }
}

function saveDatabase() {
  localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(appData));
  updateBadgesAndSelects();
}

function resetToSpreadsheetDefaults() {
  if (confirm('Deseja realmente restaurar todos os dados para a planilha original Toledo_v2? Alterações manuais não salvas serão perdidas.')) {
    appData = JSON.parse(JSON.stringify(DEFAULT_DATABASE));
    saveDatabase();
    initApp();
    showToast('Base restaurada com sucesso a partir da planilha Toledo_v2!');
  }
}

function initApp() {
  ensureAllInstallments();
  populateFilterSelects();
  updateCalculations();
  renderDashboard();
  renderInventory();
  renderExpensesTable();
  renderDocumentsGrid();
  renderPaymentsMatrix();
  renderActiveFinancings();
}

// ============================================================================
// FORMATADORES E UTILITÁRIOS
// ============================================================================
function formatMoney(value) {
  const num = Number(value) || 0;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

function showToast(message) {
  const toast = document.getElementById('toastNotification');
  const msg = document.getElementById('toastMsg');
  if (!toast || !msg) return;
  msg.textContent = message;
  toast.style.display = 'flex';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 3500);
}

// ============================================================================
// CÁLCULOS AUTOMÁTICOS DAS REGRAS DE NEGÓCIO
// ============================================================================
function updateCalculations() {
  appData.veiculos.forEach(v => {
    // 1. Soma das despesas vinculadas a este veículo
    const despesasDoCarro = appData.despesas.filter(d => Number(d.veiculoId) === Number(v.id));
    const totalDesp = despesasDoCarro.reduce((acc, curr) => acc + (Number(curr.valor) || 0), 0);
    v.despesasTotal = totalDesp;

    // 2. Custo Final = Valor de Compra + Despesas Total
    v.custoFinal = (Number(v.valorCompra) || 0) + totalDesp;

    // 3. Lucro = Valor de Venda - Custo Final
    if (v.status === 'Vendido' && Number(v.valorVenda) > 0) {
      v.lucro = (Number(v.valorVenda) || 0) - v.custoFinal;
    } else {
      v.lucro = 0;
    }
  });

  updateBadgesAndSelects();
}

function updateBadgesAndSelects() {
  const stockCount = appData.veiculos.length;
  const inStockCount = appData.veiculos.filter(v => v.status !== 'Vendido').length;
  const soldCount = appData.veiculos.filter(v => v.status === 'Vendido').length;

  document.getElementById('badgeStockCount').textContent = stockCount;
  document.getElementById('badgeExpensesCount').textContent = appData.despesas.length;
  document.getElementById('badgeDocsCount').textContent = appData.documentos.length;

  const tileEstoqueSub = document.getElementById('tileEstoqueSub');
  if (tileEstoqueSub) tileEstoqueSub.textContent = `${inStockCount} em estoque • ${soldCount} vendidos`;

  const tileDespesasSub = document.getElementById('tileDespesasSub');
  if (tileDespesasSub) tileDespesasSub.textContent = `${appData.despesas.length} despesas cadastradas`;

  const tileDocsSub = document.getElementById('tileDocumentosSub');
  if (tileDocsSub) tileDocsSub.textContent = `${appData.documentos.length} anexos e laudos`;
}

function populateFilterSelects() {
  // Select de Marcas
  const marcas = [...new Set(appData.veiculos.map(v => v.marca).filter(Boolean))].sort();
  const filterMarca = document.getElementById('filterMarca');
  if (filterMarca) {
    const currentVal = filterMarca.value;
    filterMarca.innerHTML = '<option value="todas">Todas as Marcas</option>';
    marcas.forEach(m => {
      filterMarca.innerHTML += `<option value="${m}">${m}</option>`;
    });
    filterMarca.value = currentVal || 'todas';
  }

  // Select de Carros no Modal de Despesa e Documento
  const expCarSelect = document.getElementById('expCarSelect');
  const docCarSelect = document.getElementById('docCarSelect');
  const filterExpenseVehicle = document.getElementById('filterExpenseVehicle');
  const filterDocVehicle = document.getElementById('filterDocVehicle');

  const optionsHtml = appData.veiculos.map(v =>
    `<option value="${v.id}">ID ${v.id} - ${v.marca} ${v.modelo} (${v.placa})</option>`
  ).join('');

  if (expCarSelect) expCarSelect.innerHTML = optionsHtml;
  if (docCarSelect) docCarSelect.innerHTML = optionsHtml;

  const filterOptionsHtml = '<option value="todos">Todos os Veículos</option>' + optionsHtml;
  if (filterExpenseVehicle) filterExpenseVehicle.innerHTML = filterOptionsHtml;
  if (filterDocVehicle) filterDocVehicle.innerHTML = filterOptionsHtml;
}

// ============================================================================
// NAVEGAÇÃO ENTRE TELAS
// ============================================================================
function switchView(viewName) {
  const views = ['viewDashboard', 'viewInventory', 'viewExpenses', 'viewDocuments', 'viewPayments', 'viewVehicleDetail', 'viewBackup'];
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = 'none';
  });

  const navs = ['navDashboard', 'navInventory', 'navExpenses', 'navDocuments', 'navPayments', 'navBackup'];
  navs.forEach(n => {
    const el = document.getElementById(n);
    if (el) el.classList.remove('active');
  });

  if (viewName === 'dashboard') {
    document.getElementById('viewDashboard').style.display = 'block';
    document.getElementById('navDashboard').classList.add('active');
    renderDashboard();
  } else if (viewName === 'inventory') {
    document.getElementById('viewInventory').style.display = 'block';
    document.getElementById('navInventory').classList.add('active');
    renderInventory();
  } else if (viewName === 'expenses') {
    document.getElementById('viewExpenses').style.display = 'block';
    document.getElementById('navExpenses').classList.add('active');
    renderExpensesTable();
  } else if (viewName === 'documents') {
    document.getElementById('viewDocuments').style.display = 'block';
    document.getElementById('navDocuments').classList.add('active');
    renderDocumentsGrid();
  } else if (viewName === 'payments') {
    document.getElementById('viewPayments').style.display = 'block';
    document.getElementById('navPayments').classList.add('active');
    renderPaymentsMatrix();
    renderActiveFinancings();
  } else if (viewName === 'detail') {
    document.getElementById('viewVehicleDetail').style.display = 'block';
    renderVehicleDetail(currentDetailCarId);
  } else if (viewName === 'backup') {
    document.getElementById('viewBackup').style.display = 'block';
    document.getElementById('navBackup').classList.add('active');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================================
// DASHBOARD VIEW
// ============================================================================
function renderDashboard() {
  updateCalculations();

  // KPIs
  const inStockCars = appData.veiculos.filter(v => v.status !== 'Vendido');
  const soldCars = appData.veiculos.filter(v => v.status === 'Vendido');

  const totalEstoqueCusto = inStockCars.reduce((acc, v) => acc + (v.custoFinal || 0), 0);
  const totalLucro = soldCars.reduce((acc, v) => acc + (v.lucro || 0), 0);
  const totalVendasValor = soldCars.reduce((acc, v) => acc + (Number(v.valorVenda) || 0), 0);
  const totalDespesas = appData.despesas.reduce((acc, d) => acc + (Number(d.valor) || 0), 0);

  document.getElementById('kpiEstoqueValor').textContent = formatMoney(totalEstoqueCusto);
  document.getElementById('kpiEstoqueCount').textContent = `${inStockCars.length} veículos em pátio`;

  document.getElementById('kpiLucroTotal').textContent = formatMoney(totalLucro);
  document.getElementById('kpiCarrosVendidos').textContent = soldCars.length;
  document.getElementById('kpiVendaTotalValor').textContent = `${formatMoney(totalVendasValor)} em vendas`;

  document.getElementById('kpiDespesasTotal').textContent = formatMoney(totalDespesas);
  document.getElementById('kpiDespesasCount').textContent = `${appData.despesas.length} despesas lançadas`;

  // Veículos de destaque no dashboard
  const container = document.getElementById('dashboardVehiclesGrid');
  if (container) {
    const featured = appData.veiculos.slice(0, 4);
    container.innerHTML = featured.map(v => createVehicleCardHtml(v)).join('');
  }

  // Gráficos
  renderDashboardCharts();
}

function renderDashboardCharts() {
  const ctxLucro = document.getElementById('chartLucroCarros');
  const ctxCat = document.getElementById('chartCategoriasDespesas');

  if (ctxLucro) {
    if (chartLucroInstance) chartLucroInstance.destroy();

    // Comparativo de carros vendidos: Custo Final vs Venda
    const sold = appData.veiculos.filter(v => v.status === 'Vendido');
    const labels = sold.map(v => `${v.marca} ${v.modelo.split(' ')[0]}`);
    const custos = sold.map(v => v.custoFinal);
    const vendas = sold.map(v => Number(v.valorVenda) || 0);

    chartLucroInstance = new Chart(ctxLucro, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Custo Final (Compra + Despesas)',
            data: custos,
            backgroundColor: 'rgba(59, 130, 246, 0.75)',
            borderRadius: 6
          },
          {
            label: 'Valor de Venda',
            data: vendas,
            backgroundColor: 'rgba(16, 185, 129, 0.85)',
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans' } } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${formatMoney(ctx.raw)}`
            }
          }
        },
        scales: {
          y: {
            ticks: {
              color: '#64748b',
              callback: (val) => 'R$ ' + (val / 1000) + 'k'
            },
            grid: { color: 'rgba(255, 255, 255, 0.05)' }
          },
          x: {
            ticks: { color: '#94a3b8' },
            grid: { display: false }
          }
        }
      }
    });
  }

  if (ctxCat) {
    if (chartCategoriasInstance) chartCategoriasInstance.destroy();

    // Agrupamento por categoria
    const catMap = {};
    appData.despesas.forEach(d => {
      const cat = d.categoria || 'Outros';
      catMap[cat] = (catMap[cat] || 0) + (Number(d.valor) || 0);
    });

    const catLabels = Object.keys(catMap);
    const catValues = Object.values(catMap);

    chartCategoriasInstance = new Chart(ctxCat, {
      type: 'doughnut',
      data: {
        labels: catLabels,
        datasets: [{
          data: catValues,
          backgroundColor: [
            '#2563eb', '#10b981', '#f59e0b', '#8b5cf6',
            '#ef4444', '#06b6d4', '#ec4899', '#64748b'
          ],
          borderWidth: 2,
          borderColor: 'transparent'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, color: '#94a3b8', font: { size: 10 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.label}: ${formatMoney(ctx.raw)}`
            }
          }
        }
      }
    });
  }
}

// ============================================================================
// INVENTORY VIEW (CARDS & TABELA)
// ============================================================================
function setInventoryViewMode(mode) {
  currentInventoryView = mode;
  document.getElementById('btnViewCards').classList.toggle('active', mode === 'cards');
  document.getElementById('btnViewTable').classList.toggle('active', mode === 'table');

  document.getElementById('inventoryCardsContainer').style.display = mode === 'cards' ? 'grid' : 'none';
  document.getElementById('inventoryTableContainer').style.display = mode === 'table' ? 'block' : 'none';
  renderInventory();
}

function applyVehicleFilters() {
  renderInventory();
}

function getFilteredVehicles() {
  const statusFilter = document.getElementById('filterStatus') ? document.getElementById('filterStatus').value : 'todos';
  const marcaFilter = document.getElementById('filterMarca') ? document.getElementById('filterMarca').value : 'todas';
  const socFilter = document.getElementById('filterSociedade') ? document.getElementById('filterSociedade').value : 'todos';
  const searchTerm = (document.getElementById('globalSearchInput') ? document.getElementById('globalSearchInput').value : '').toLowerCase().trim();

  return appData.veiculos.filter(v => {
    // Status
    if (statusFilter !== 'todos' && v.status !== statusFilter) return false;
    // Marca
    if (marcaFilter !== 'todas' && v.marca !== marcaFilter) return false;
    // Sociedade
    if (socFilter === 'Lagoa' && v.sociedade !== 'Lagoa') return false;
    if (socFilter === 'sem_sociedade' && v.sociedade) return false;

    // Busca textual
    if (searchTerm) {
      const match =
        (v.modelo || '').toLowerCase().includes(searchTerm) ||
        (v.marca || '').toLowerCase().includes(searchTerm) ||
        (v.placa || '').toLowerCase().includes(searchTerm) ||
        (v.comprador || '').toLowerCase().includes(searchTerm) ||
        (v.antigoDono || '').toLowerCase().includes(searchTerm);
      if (!match) return false;
    }

    return true;
  });
}

function renderInventory() {
  updateCalculations();
  const list = getFilteredVehicles();

  // Cards
  const cardsContainer = document.getElementById('inventoryCardsContainer');
  if (cardsContainer) {
    if (list.length === 0) {
      cardsContainer.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">Nenhum veículo encontrado com os filtros aplicados.</div>';
    } else {
      cardsContainer.innerHTML = list.map(v => createVehicleCardHtml(v)).join('');
    }
  }

  // Tabela
  const tableBody = document.getElementById('inventoryTableBody');
  if (tableBody) {
    if (list.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="17" style="text-align: center; padding: 30px; color: var(--text-dim);">Nenhum veículo encontrado.</td></tr>';
    } else {
      tableBody.innerHTML = list.map(v => `
        <tr>
          <td><strong>#${v.id}</strong></td>
          <td>
            <div class="table-cell-car">
              <div>
                <strong style="font-size: 0.95rem;">${v.marca} ${v.modelo}</strong>
                ${v.sociedade ? `<span style="font-size: 0.72rem; color: var(--purple); font-weight: 700; display: block;">Sociedade: ${v.sociedade}</span>` : ''}
              </div>
            </div>
          </td>
          <td><span style="font-family: monospace; font-weight: 700;">${v.placa}</span></td>
          <td>${v.ano}</td>
          <td>${formatDate(v.dataCompra)}</td>
          <td>${formatMoney(v.valorCompra)}</td>
          <td style="color: var(--danger); font-weight: 600;">${formatMoney(v.despesasTotal)}</td>
          <td><strong>${formatMoney(v.custoFinal)}</strong></td>
          <td style="color: var(--text-dim);">${formatMoney(v.valorFipe)}</td>
          <td>${formatDate(v.dataVenda)}</td>
          <td>${v.comprador || '-'}</td>
          <td><strong style="color: var(--success);">${v.valorVenda ? formatMoney(v.valorVenda) : '-'}</strong></td>
          <td>${v.valorEntrada ? formatMoney(v.valorEntrada) : '-'}</td>
          <td>${v.numParcelas ? `${v.numParcelas}x ${formatMoney(v.valorParcela)}` : (v.parcelamento || '-')}</td>
          <td><strong style="color: ${v.lucro > 0 ? 'var(--success)' : 'inherit'};">${v.lucro ? formatMoney(v.lucro) : '-'}</strong></td>
          <td>
            <span class="status-pill ${v.status === 'Vendido' ? 'pago' : (v.status === 'Em estoque' ? 'upcoming' : 'pendente')}">
              ${v.status}
            </span>
          </td>
          <td>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-secondary btn-sm" onclick="viewCarDetail(${v.id})" title="Ver Ficha">Ver</button>
              <button class="btn btn-secondary btn-sm" onclick="editCarById(${v.id})" title="Editar">✏️</button>
            </div>
          </td>
        </tr>
      `).join('');
    }
  }
}

function createVehicleCardHtml(v) {
  let badgeClass = 'badge-in-stock';
  if (v.status === 'Vendido') badgeClass = 'badge-sold';
  if (v.status === 'Em preparação') badgeClass = 'badge-in-preparation';

  return `
    <div class="vehicle-card" id="cardCar_${v.id}">
      <div class="vehicle-card-topbar">
        <span class="vehicle-plate-pill">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="12" x="3" y="6" rx="2"/></svg>
          ${v.placa}
        </span>
        <div class="vehicle-card-badges">
          ${v.sociedade ? `<span class="vehicle-badge-sociedade" style="position: static;">Soc. ${v.sociedade}</span>` : ''}
          <span class="vehicle-badge-status ${badgeClass}" style="position: static;">${v.status}</span>
        </div>
      </div>

      <div class="vehicle-card-body">
        <div class="vehicle-title-wrap">
          <h3 class="vehicle-model-name">${v.marca} ${v.modelo}</h3>
          <span style="font-size: 0.78rem; color: var(--text-dim); margin-top: 2px;">
            Ano ${v.ano} ${v.km ? `• ${Number(v.km).toLocaleString('pt-BR')} km` : ''}
          </span>
        </div>

        <div class="vehicle-specs-row">
          <div class="vehicle-spec-item">
            <span>⛽ ${v.combustivel || 'Flex'}</span>
          </div>
          <div class="vehicle-spec-item">
            <span>⚙️ ${v.cambio || 'Manual'}</span>
          </div>
          <div class="vehicle-spec-item">
            <span>🛠️ ${formatMoney(v.despesasTotal)} desp.</span>
          </div>
        </div>

        <div class="vehicle-financial-summary">
          <div class="price-block">
            <span class="price-label">${v.status === 'Vendido' ? 'Valor da Venda' : 'Custo Total Acumulado'}</span>
            <span class="price-main">${v.status === 'Vendido' ? formatMoney(v.valorVenda) : formatMoney(v.custoFinal)}</span>
          </div>
          <div>
            ${v.status === 'Vendido'
      ? `<span class="profit-text">+${formatMoney(v.lucro)} lucro</span>`
      : `<span style="font-size: 0.76rem; color: var(--text-dim);">FIPE: ${formatMoney(v.valorFipe)}</span>`
    }
          </div>
        </div>

        <div class="vehicle-card-actions">
          <button class="btn btn-secondary btn-sm" style="flex: 1;" onclick="viewCarDetail(${v.id})">
            Ver Detalhes
          </button>
          ${v.status !== 'Vendido'
      ? `<button class="btn btn-success btn-sm" onclick="openModalSellVehicle(${v.id})" title="Registrar Venda">Vender</button>`
      : `<button class="btn btn-secondary btn-sm" onclick="viewCarDetail(${v.id}, 'pagamentos')" title="Ver Carnê">Carnê</button>`
    }
          <button class="btn btn-secondary btn-sm" onclick="openModalAddExpenseForCar(${v.id})" title="Lançar Despesa">+</button>
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// FICHA DETALHADA DO VEÍCULO (DETAIL VIEW - Mockup 21.29.26 (2))
// ============================================================================
function viewCarDetail(carId, defaultTab = 'despesas') {
  currentDetailCarId = Number(carId);
  switchView('detail');
  switchDetailTab(defaultTab);
}

function renderVehicleDetail(carId) {
  const car = appData.veiculos.find(v => Number(v.id) === Number(carId));
  if (!car) {
    showToast('Veículo não encontrado.');
    switchView('inventory');
    return;
  }

  // Preencher dados da barra lateral
  document.getElementById('detailCarTitle').textContent = `${car.marca} ${car.modelo}`;
  document.getElementById('detailCarSubtitle').textContent = `Placa: ${car.placa} • Ano: ${car.ano} • Comprado em ${formatDate(car.dataCompra)}`;

  const bannerPlate = document.getElementById('detailCarBannerPlate');
  if (bannerPlate) bannerPlate.textContent = car.placa;
  const bannerStatus = document.getElementById('detailCarBannerStatus');
  if (bannerStatus) bannerStatus.textContent = `${car.marca} ${car.modelo} (${car.ano})`;

  const badge = document.getElementById('detailCarStatusBadge');
  badge.textContent = car.status;
  badge.className = `status-pill ${car.status === 'Vendido' ? 'pago' : 'upcoming'}`;

  const profitBadge = document.getElementById('detailCarProfitBadge');
  profitBadge.textContent = car.status === 'Vendido' ? `Lucro: ${formatMoney(car.lucro)}` : '';

  document.getElementById('detailSpecMarca').textContent = car.marca;
  document.getElementById('detailSpecAno').textContent = car.ano;
  document.getElementById('detailSpecPlaca').textContent = car.placa;
  document.getElementById('detailSpecCambio').textContent = car.cambio || 'Manual';
  document.getElementById('detailSpecCombustivel').textContent = car.combustivel || 'Flex';
  document.getElementById('detailSpecSociedade').textContent = car.sociedade ? `Sociedade ${car.sociedade}` : 'Próprio';

  document.getElementById('detailFinCompra').textContent = formatMoney(car.valorCompra);
  document.getElementById('detailFinDespesas').textContent = formatMoney(car.despesasTotal);
  document.getElementById('detailFinCustoFinal').textContent = formatMoney(car.custoFinal);
  document.getElementById('detailFinFipe').textContent = formatMoney(car.valorFipe);

  const vendaRow = document.getElementById('detailFinVendaRow');
  const lucroRow = document.getElementById('detailFinLucroRow');
  const btnSell = document.getElementById('btnSellCarAction');

  if (car.status === 'Vendido') {
    vendaRow.style.display = 'flex';
    lucroRow.style.display = 'flex';
    document.getElementById('detailFinVenda').textContent = formatMoney(car.valorVenda);
    document.getElementById('detailFinLucro').textContent = formatMoney(car.lucro);
    btnSell.style.display = 'none';
  } else {
    vendaRow.style.display = 'none';
    lucroRow.style.display = 'none';
    btnSell.style.display = 'inline-flex';
  }

  // Preencher Despesas Vinculadas
  const carExpenses = appData.despesas.filter(d => Number(d.veiculoId) === Number(car.id));
  document.getElementById('detailCarExpensesCount').textContent = carExpenses.length;
  const expTableBody = document.getElementById('detailCarExpensesTableBody');
  if (carExpenses.length === 0) {
    expTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--text-dim);">Nenhuma despesa cadastrada para este carro ainda.</td></tr>';
  } else {
    expTableBody.innerHTML = carExpenses.map(d => `
      <tr>
        <td>${formatDate(d.data)}</td>
        <td><span class="status-pill upcoming">${d.categoria}</span></td>
        <td><strong>${d.item}</strong></td>
        <td><strong style="color: var(--danger);">${formatMoney(d.valor)}</strong></td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="deleteExpense(${d.id})" title="Excluir">Excluir</button>
        </td>
      </tr>
    `).join('');
  }

  // Preencher Documentos Vinculados
  const carDocs = appData.documentos.filter(doc => Number(doc.veiculoId) === Number(car.id));
  document.getElementById('detailCarDocsCount').textContent = carDocs.length;
  const docsGrid = document.getElementById('detailCarDocsGrid');
  if (carDocs.length === 0) {
    docsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--text-dim);">Nenhum documento ou laudo anexado.</div>';
  } else {
    docsGrid.innerHTML = carDocs.map(doc => createDocumentCardHtml(doc)).join('');
  }

  // Preencher Carnê & Pagamentos
  renderDetailCarPayments(car);
}

function switchDetailTab(tabName) {
  document.getElementById('detailPanelExpenses').style.display = tabName === 'despesas' ? 'block' : 'none';
  document.getElementById('detailPanelDocs').style.display = tabName === 'documentos' ? 'block' : 'none';
  document.getElementById('detailPanelPayments').style.display = tabName === 'pagamentos' ? 'block' : 'none';

  document.getElementById('tabBtnDespesasCarro').classList.toggle('active', tabName === 'despesas');
  document.getElementById('tabBtnDocsCarro').classList.toggle('active', tabName === 'documentos');
  document.getElementById('tabBtnPagamentosCarro').classList.toggle('active', tabName === 'pagamentos');
}

function ensureInstallmentsForCar(car) {
  if (!car || car.status !== 'Vendido') return;
  const numParc = Number(car.numParcelas) || 0;
  const valParc = Number(car.valorParcela) || 0;
  if (numParc <= 0) return;

  const existing = appData.pagamentos.filter(p => Number(p.veiculoId) === Number(car.id));
  const existingNums = new Set(existing.map(p => Number(p.numeroParcela)));

  if (existing.length < numParc) {
    const saleDate = new Date(car.dataVenda || new Date().toISOString().slice(0, 10));
    for (let i = 1; i <= Math.min(numParc, 120); i++) {
      if (!existingNums.has(i)) {
        const dueDate = new Date(saleDate);
        dueDate.setMonth(dueDate.getMonth() + i);
        const yyyy = dueDate.getFullYear();
        const mm = String(dueDate.getMonth() + 1).padStart(2, '0');
        const dd = String(Math.min(saleDate.getDate() || 25, 28)).padStart(2, '0');
        const dueDateStr = `${yyyy}-${mm}-${dd}`;
        const isPaidDefault = (car.id === 1 && i === 1); // Toro parcela 1 já paga na base original

        appData.pagamentos.push({
          id: Date.now() + Math.floor(Math.random() * 100000) + i,
          veiculoId: car.id,
          numeroParcela: i,
          dataVencimento: dueDateStr,
          dataPagamento: isPaidDefault ? dueDateStr : '',
          valor: valParc,
          valorPago: isPaidDefault ? valParc : null,
          status: isPaidDefault ? 'pago' : 'pendente',
          mesRef: `${yyyy}-${mm}`,
          observacao: isPaidDefault ? 'Pago na entrada/Setembro' : ''
        });
      }
    }
  }
}

function ensureAllInstallments() {
  let changed = false;
  appData.veiculos.forEach(v => {
    if (v.status === 'Vendido' && (v.numParcelas > 0)) {
      const beforeCount = appData.pagamentos.length;
      ensureInstallmentsForCar(v);
      if (appData.pagamentos.length !== beforeCount) {
        changed = true;
      }
    }
  });
  if (changed) {
    saveDatabase();
  }
}

function renderDetailCarPayments(car) {
  const summaryBox = document.getElementById('detailPaymentSummaryBox');
  const tableBody = document.getElementById('detailCarPaymentsTableBody');

  if (car.status !== 'Vendido') {
    summaryBox.innerHTML = '<span>Veículo em estoque. Registre a venda para gerar o cronograma de parcelas e carnê.</span>';
    tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--text-dim);">Sem parcelamento ativo.</td></tr>';
    return;
  }

  const numParc = car.numParcelas || 0;
  const valParc = car.valorParcela || 0;
  const entrada = car.valorEntrada || 0;

  // Garante que todo o carnê esteja gerado
  ensureInstallmentsForCar(car);

  // Buscar parcelas salvas
  let existingPayments = appData.pagamentos.filter(p => Number(p.veiculoId) === Number(car.id));

  // Ordenar por número da parcela
  existingPayments.sort((a, b) => (Number(a.numeroParcela) || 0) - (Number(b.numeroParcela) || 0));

  const pagos = existingPayments.filter(p => p.status === 'pago');
  const pendentes = existingPayments.filter(p => p.status !== 'pago');
  const saldoDevedor = pendentes.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);

  summaryBox.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">
      <div>
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <strong style="font-size: 1.05rem;">Comprador: ${car.comprador || 'Não informado'}</strong>
          <span class="status-pill ${pendentes.length === 0 ? 'pago' : 'upcoming'}">
            ${pendentes.length === 0 ? 'TOTALMENTE QUITADO' : `${pendentes.length} parcelas em aberto`}
          </span>
        </div>
        <div style="font-size: 0.84rem; color: var(--text-muted); margin-top: 4px;">
          Entrada: <strong>${formatMoney(entrada)}</strong> • Financiamento: <strong>${numParc}x de ${formatMoney(valParc)}</strong> • Saldo em aberto: <strong style="color: ${pendentes.length === 0 ? 'var(--success)' : 'var(--warning)'}; font-size: 0.95rem;">${formatMoney(saldoDevedor)}</strong>
        </div>
      </div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="btn btn-secondary btn-sm" onclick="openModalEditInstallments(${car.id})" title="Alterar quantidade e valor das parcelas">
          ⚙️ Editar Parcelas
        </button>
        ${pendentes.length > 0 ? `
          <button class="btn btn-success btn-sm" onclick="openModalSettlement(${car.id})" title="Fazer quitação total ou parcial informando o valor">
            💰 Quitação (Total/Parcial)
          </button>
        ` : ''}
        <button class="btn btn-secondary btn-sm" onclick="printSingleCarCarnet(${car.id})">
          🖨️ Imprimir Carnê
        </button>
      </div>
    </div>
  `;

  tableBody.innerHTML = existingPayments.map(p => `
    <tr>
      <td><strong>Parcela ${p.numeroParcela} / ${numParc}</strong></td>
      <td>${formatDate(p.dataVencimento)}</td>
      <td><strong>${formatMoney(p.valor)}</strong></td>
      <td><span class="status-pill ${p.status === 'pago' ? 'pago' : 'pendente'}">${p.status.toUpperCase()}</span></td>
      <td>${p.dataPagamento ? formatDate(p.dataPagamento) : '-'}</td>
      <td>
        ${p.status !== 'pago'
      ? `<button class="btn btn-success btn-sm" onclick="openModalSettlement(${car.id}, ${p.id})" title="Quitar parcela informando o valor a ser pago">Quitar</button>`
      : `<button class="btn btn-secondary btn-sm" onclick="togglePayInstallment(${p.id})" title="Estornar parcela para pendente">Estornar</button>`
    }
      </td>
    </tr>
  `).join('');
}

function togglePayInstallment(paymentId) {
  const p = appData.pagamentos.find(item => Number(item.id) === Number(paymentId));
  if (!p) return;

  if (p.status === 'pago') {
    if (confirm(`Deseja realmente estornar a Parcela ${p.numeroParcela} e retorná-la para pendente?`)) {
      p.status = 'pendente';
      p.dataPagamento = '';
      p.valorPago = null;
      p.observacao = '';
      saveDatabase();
      if (currentDetailCarId) renderDetailCarPayments(appData.veiculos.find(v => v.id === currentDetailCarId));
      renderPaymentsMatrix();
      renderActiveFinancings();
      showToast(`Parcela ${p.numeroParcela} estornada para pendente.`);
    }
  } else {
    // Abre a modal para informar o valor da quitação desta parcela
    openModalSettlement(p.veiculoId, p.id);
  }
}

// ============================================================================
// DESPESAS VIEW (EXPENSES)
// ============================================================================
function renderExpensesTable() {
  const vehFilter = document.getElementById('filterExpenseVehicle') ? document.getElementById('filterExpenseVehicle').value : 'todos';
  const catFilter = document.getElementById('filterExpenseCategory') ? document.getElementById('filterExpenseCategory').value : 'todas';

  let list = appData.despesas;

  if (vehFilter !== 'todos') {
    list = list.filter(d => Number(d.veiculoId) === Number(vehFilter));
  }

  if (catFilter !== 'todas') {
    list = list.filter(d => d.categoria === catFilter);
  }

  const total = list.reduce((acc, d) => acc + (Number(d.valor) || 0), 0);
  const expKpiTotal = document.getElementById('expKpiTotal');
  if (expKpiTotal) expKpiTotal.textContent = formatMoney(total);

  const tbody = document.getElementById('expensesTableBody');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 30px; color: var(--text-dim);">Nenhuma despesa encontrada com os filtros selecionados.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(d => {
    const car = appData.veiculos.find(v => Number(v.id) === Number(d.veiculoId));
    const carDesc = car ? `${car.marca} ${car.modelo}` : (d.modelo || 'Veículo');
    const carPlate = car ? car.placa : (d.placa || '-');

    return `
      <tr>
        <td>#${d.id}</td>
        <td>${formatDate(d.data)}</td>
        <td><strong>${carDesc}</strong></td>
        <td><span style="font-family: monospace;">${carPlate}</span></td>
        <td><span class="status-pill upcoming">${d.categoria || 'Geral'}</span></td>
        <td>${d.item}</td>
        <td><strong style="color: var(--danger);">${formatMoney(d.valor)}</strong></td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="deleteExpense(${d.id})" title="Remover Despesa">Excluir</button>
        </td>
      </tr>
    `;
  }).join('');
}

function deleteExpense(expId) {
  if (confirm('Deseja realmente excluir este lançamento de despesa?')) {
    appData.despesas = appData.despesas.filter(d => Number(d.id) !== Number(expId));
    saveDatabase();
    updateCalculations();
    renderExpensesTable();
    if (currentDetailCarId) renderVehicleDetail(currentDetailCarId);
    showToast('Despesa excluída e custo do veículo recalculado.');
  }
}

// ============================================================================
// DOCUMENTOS VIEW (DOCUMENTS)
// ============================================================================
function renderDocumentsGrid() {
  const vehFilter = document.getElementById('filterDocVehicle') ? document.getElementById('filterDocVehicle').value : 'todos';
  const typeFilter = document.getElementById('filterDocType') ? document.getElementById('filterDocType').value : 'todos';

  let list = appData.documentos;
  if (vehFilter !== 'todos') list = list.filter(d => Number(d.veiculoId) === Number(vehFilter));
  if (typeFilter !== 'todos') list = list.filter(d => d.tipo === typeFilter);

  const container = document.getElementById('documentsGridContainer');
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">Nenhum documento encontrado.</div>';
    return;
  }

  container.innerHTML = list.map(doc => createDocumentCardHtml(doc)).join('');
}

function createDocumentCardHtml(doc) {
  const car = appData.veiculos.find(v => Number(v.id) === Number(doc.veiculoId));
  const carDesc = car ? `${car.marca} ${car.modelo}` : 'Veículo';
  const carPlate = car ? car.placa : '';

  let iconSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`;

  return `
    <div class="kpi-card" style="gap: 14px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div class="kpi-icon-pill amber">${iconSvg}</div>
        <span class="status-pill upcoming">${doc.tipo}</span>
      </div>

      <div>
        <h3 style="font-size: 1.1rem; font-weight: 700;">${doc.tipo} - ${carPlate}</h3>
        <span style="font-size: 0.8rem; color: var(--text-muted);">${carDesc}</span>
      </div>

      ${doc.observacao ? `<p style="font-size: 0.78rem; color: var(--text-dim);">${doc.observacao}</p>` : ''}

      <div style="font-size: 0.74rem; color: var(--text-dim);">
        Data: ${formatDate(doc.dataUpload)}
      </div>

      <div style="display: flex; gap: 8px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border-color);">
        <a href="${doc.link}" target="_blank" class="btn btn-primary btn-sm" style="flex: 1;" title="Abrir link do Google Drive ou anexo">
          Abrir Arquivo
        </a>
        <button class="btn btn-secondary btn-sm" onclick="copyLink('${doc.link}')" title="Copiar Link">
          Copiar
        </button>
        <button class="btn btn-danger btn-sm" onclick="deleteDocument(${doc.id})" title="Excluir">
          ✕
        </button>
      </div>
    </div>
  `;
}

function copyLink(text) {
  navigator.clipboard.writeText(text);
  showToast('Link copiado para a área de transferência!');
}

function deleteDocument(docId) {
  if (confirm('Deseja realmente remover este documento?')) {
    appData.documentos = appData.documentos.filter(d => Number(d.id) !== Number(docId));
    saveDatabase();
    renderDocumentsGrid();
    if (currentDetailCarId) renderVehicleDetail(currentDetailCarId);
    showToast('Documento removido.');
  }
}

// ============================================================================
// PAGAMENTOS & CARNÊ (PAYMENTS)
// ============================================================================
function setPaymentsYear(year) {
  currentPaymentsYear = year;
  document.getElementById('btnYear2026').classList.toggle('active', year === 2026);
  document.getElementById('btnYear2027').classList.toggle('active', year === 2027);
  renderPaymentsMatrix();
}

function renderPaymentsMatrix() {
  const tbody = document.getElementById('paymentsMatrixBody');
  if (!tbody) return;

  const meses = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

  tbody.innerHTML = appData.veiculos.map(v => {
    const isSold = v.status === 'Vendido';
    const isParc = v.parcelamento === 'Parcelado' || (v.numParcelas > 0);

    let cellsHtml = '';
    meses.forEach(m => {
      const mesRef = `${currentPaymentsYear}-${m}`;
      const pagamento = appData.pagamentos.find(p => Number(p.veiculoId) === Number(v.id) && p.mesRef === mesRef);

      if (pagamento) {
        if (pagamento.status === 'pago') {
          cellsHtml += `<td class="paid-cell" title="Pago em ${formatDate(pagamento.dataPagamento)}">Paga (${pagamento.numeroParcela})</td>`;
        } else {
          cellsHtml += `<td style="color: var(--warning); font-weight: 600;" title="A vencer">Parc. ${pagamento.numeroParcela}</td>`;
        }
      } else {
        // Exemplo especial da Toro no Excel Toledo (Setembro 2026 = 1/43)
        if (v.id === 1 && currentPaymentsYear === 2026 && m === '09') {
          cellsHtml += `<td class="paid-cell">1/43</td>`;
        } else {
          cellsHtml += `<td style="color: var(--text-dim);">-</td>`;
        }
      }
    });

    return `
      <tr>
        <td><strong>#${v.id}</strong></td>
        <td style="text-align: left;"><strong>${v.marca} ${v.modelo}</strong></td>
        ${cellsHtml}
      </tr>
    `;
  }).join('');
}

function renderActiveFinancings() {
  const tbody = document.getElementById('activeFinancingTableBody');
  if (!tbody) return;

  const soldFinanced = appData.veiculos.filter(v => v.status === 'Vendido' && (v.numParcelas > 0));

  if (soldFinanced.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 20px; color: var(--text-dim);">Nenhum financiamento ativo no momento.</td></tr>';
    return;
  }

  tbody.innerHTML = soldFinanced.map(v => {
    const pendentes = appData.pagamentos.filter(p => Number(p.veiculoId) === Number(v.id) && p.status !== 'pago');
    const pagosCount = appData.pagamentos.filter(p => Number(p.veiculoId) === Number(v.id) && p.status === 'pago').length;
    const totalParc = v.numParcelas || 0;
    const valorParc = v.valorParcela || 0;
    const saldoDevedor = pendentes.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    const isQuitado = pendentes.length === 0 && totalParc > 0;

    return `
      <tr>
        <td><strong>${v.marca} ${v.modelo}</strong><br><span style="font-size: 0.75rem; color: var(--text-dim);">${v.placa}</span></td>
        <td>${v.comprador || 'Cliente'}</td>
        <td><strong>${formatMoney(v.valorVenda)}</strong></td>
        <td>${formatMoney(v.valorEntrada)}</td>
        <td>${totalParc} parcelas</td>
        <td><strong>${formatMoney(valorParc)}</strong></td>
        <td><span class="status-pill pago">${pagosCount} pagas</span></td>
        <td><strong style="color: ${isQuitado ? 'var(--success)' : 'var(--warning)'};">${formatMoney(saldoDevedor)}</strong></td>
        <td><span class="status-pill ${isQuitado ? 'pago' : 'upcoming'}">${isQuitado ? 'QUITADO' : 'Em dia'}</span></td>
        <td>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button class="btn btn-secondary btn-sm" onclick="viewCarDetail(${v.id}, 'pagamentos')" title="Abrir Carnê Completo">Carnê</button>
            ${!isQuitado ? `
              <button class="btn btn-success btn-sm" onclick="openModalSettlement(${v.id})" title="Fazer quitação total ou parcial informando o valor">💰 Quitar</button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ============================================================================
// MODAIS E FORMULÁRIOS
// ============================================================================
function openModal(modalId) {
  const m = document.getElementById(modalId);
  if (!m) {
    console.error('Modal não encontrado:', modalId);
    return;
  }
  m.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeModal(modalId) {
  const m = document.getElementById(modalId);
  if (!m) return;
  m.classList.remove('show');
  // Restore scroll after a brief delay to allow transition
  setTimeout(() => {
    const anyOpen = document.querySelector('.modal-backdrop.show');
    if (!anyOpen) document.body.style.overflow = '';
  }, 300);
}

// Fechar modal ao clicar no backdrop escuro ou pressionar ESC
document.addEventListener('click', (e) => {
  if (e.target && e.target.classList.contains('modal-backdrop')) {
    closeModal(e.target.id);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const activeModal = document.querySelector('.modal-backdrop.show');
    if (activeModal) closeModal(activeModal.id);
  }
});

// Modal Veículo (Adicionar / Editar)
function openModalAddVehicle() {
  document.getElementById('modalVehicleTitle').textContent = 'Cadastrar Novo Veículo';
  document.getElementById('formVehicle').reset();
  document.getElementById('vehId').value = '';
  document.getElementById('vehDataCompra').value = new Date().toISOString().slice(0, 10);
  openModal('modalVehicle');
}

function editCarById(carId) {
  const car = appData.veiculos.find(v => Number(v.id) === Number(carId));
  if (!car) return;

  document.getElementById('modalVehicleTitle').textContent = `Editar Veículo #${car.id} - ${car.modelo}`;
  document.getElementById('vehId').value = car.id;
  document.getElementById('vehMarca').value = car.marca;
  document.getElementById('vehModelo').value = car.modelo;
  document.getElementById('vehAno').value = car.ano;
  document.getElementById('vehPlaca').value = car.placa;
  document.getElementById('vehCor').value = car.cor || '';
  document.getElementById('vehKm').value = car.km || '';
  document.getElementById('vehCombustivel').value = car.combustivel || 'Flex';
  document.getElementById('vehCambio').value = car.cambio || 'Manual';
  document.getElementById('vehSociedade').value = car.sociedade || '';
  document.getElementById('vehAntigoDono').value = car.antigoDono || '';
  document.getElementById('vehDataCompra').value = car.dataCompra || '';
  document.getElementById('vehValorCompra').value = car.valorCompra || '';
  document.getElementById('vehValorFipe').value = car.valorFipe || '';

  openModal('modalVehicle');
}

function editCurrentCar() {
  if (currentDetailCarId) editCarById(currentDetailCarId);
}

function handleSaveVehicle(e) {
  e.preventDefault();
  const idVal = document.getElementById('vehId').value;
  const isEdit = Boolean(idVal);

  const vehicleObj = {
    id: isEdit ? Number(idVal) : (Math.max(0, ...appData.veiculos.map(v => Number(v.id) || 0)) + 1),
    marca: document.getElementById('vehMarca').value.trim(),
    modelo: document.getElementById('vehModelo').value.trim(),
    ano: Number(document.getElementById('vehAno').value),
    placa: document.getElementById('vehPlaca').value.trim().toUpperCase(),
    cor: document.getElementById('vehCor').value.trim(),
    km: Number(document.getElementById('vehKm').value) || 0,
    combustivel: document.getElementById('vehCombustivel').value,
    cambio: document.getElementById('vehCambio').value,
    sociedade: document.getElementById('vehSociedade').value.trim(),
    antigoDono: document.getElementById('vehAntigoDono').value.trim(),
    dataCompra: document.getElementById('vehDataCompra').value,
    valorCompra: Number(document.getElementById('vehValorCompra').value) || 0,
    valorFipe: Number(document.getElementById('vehValorFipe').value) || 0,
    status: isEdit ? (appData.veiculos.find(v => Number(v.id) === Number(idVal)).status || 'Em estoque') : 'Em estoque'
  };

  if (isEdit) {
    const idx = appData.veiculos.findIndex(v => Number(v.id) === Number(idVal));
    if (idx !== -1) {
      appData.veiculos[idx] = { ...appData.veiculos[idx], ...vehicleObj };
    }
    showToast('Veículo atualizado com sucesso!');
  } else {
    vehicleObj.dataVenda = '';
    vehicleObj.comprador = '';
    vehicleObj.valorVenda = 0;
    vehicleObj.valorEntrada = 0;
    vehicleObj.numParcelas = 0;
    vehicleObj.valorParcela = 0;
    vehicleObj.lucro = 0;
    appData.veiculos.push(vehicleObj);
    showToast('Novo veículo cadastrado com sucesso!');
  }

  saveDatabase();
  closeModal('modalVehicle');
  populateFilterSelects();
  updateCalculations();
  renderDashboard();
  renderInventory();
  if (currentDetailCarId && Number(currentDetailCarId) === Number(vehicleObj.id)) {
    renderVehicleDetail(vehicleObj.id);
  }
}

// Modal Venda
function openModalSellVehicle(carId = null) {
  const targetId = carId || currentDetailCarId;
  const car = appData.veiculos.find(v => Number(v.id) === Number(targetId));
  if (!car) return;

  document.getElementById('sellVehId').value = car.id;
  document.getElementById('sellCarNameDisplay').textContent = `${car.marca} ${car.modelo} (${car.placa})`;
  document.getElementById('sellCarCustoDisplay').textContent = `Custo Final: ${formatMoney(car.custoFinal)} (Compra: ${formatMoney(car.valorCompra)} + Despesas: ${formatMoney(car.despesasTotal)})`;
  document.getElementById('sellData').value = new Date().toISOString().slice(0, 10);
  document.getElementById('sellComprador').value = '';
  document.getElementById('sellTelefone').value = '';
  document.getElementById('sellValor').value = car.valorFipe || '';
  document.getElementById('sellEntrada').value = '';
  document.getElementById('sellNumParcelas').value = '36';
  document.getElementById('sellValorParcela').value = '';
  calculateSaleProfit();

  openModal('modalSell');
}

function toggleInstallmentInputs(tipo) {
  const block = document.getElementById('installmentFieldsBlock');
  if (block) block.style.display = tipo === 'Parcelado' ? 'grid' : 'none';
}

function calculateSaleProfit() {
  const id = document.getElementById('sellVehId').value;
  const car = appData.veiculos.find(v => Number(v.id) === Number(id));
  if (!car) return;

  const sellVal = Number(document.getElementById('sellValor').value) || 0;
  const lucro = sellVal - car.custoFinal;
  document.getElementById('sellLucroCalculado').textContent = formatMoney(lucro);
}

function handleSaveSale(e) {
  e.preventDefault();
  const id = Number(document.getElementById('sellVehId').value);
  const car = appData.veiculos.find(v => Number(v.id) === id);
  if (!car) return;

  const dataVenda = document.getElementById('sellData').value;
  const comprador = document.getElementById('sellComprador').value.trim();
  const telefone = document.getElementById('sellTelefone').value.trim();
  const valorVenda = Number(document.getElementById('sellValor').value) || 0;
  const tipo = document.getElementById('sellTipo').value;
  const valorEntrada = Number(document.getElementById('sellEntrada').value) || 0;
  const numParcelas = tipo === 'Parcelado' ? (Number(document.getElementById('sellNumParcelas').value) || 0) : 0;
  const valorParcela = tipo === 'Parcelado' ? (Number(document.getElementById('sellValorParcela').value) || 0) : 0;

  car.status = 'Vendido';
  car.dataVenda = dataVenda;
  car.comprador = comprador;
  car.telefoneComprador = telefone;
  car.valorVenda = valorVenda;
  car.parcelamento = tipo;
  car.valorEntrada = valorEntrada;
  car.numParcelas = numParcelas;
  car.valorParcela = valorParcela;
  car.lucro = valorVenda - car.custoFinal;

  if (tipo === 'Parcelado' && numParcelas > 0) {
    ensureInstallmentsForCar(car);
  }

  saveDatabase();
  closeModal('modalSell');
  updateCalculations();
  renderDashboard();
  renderInventory();
  renderPaymentsMatrix();
  renderActiveFinancings();
  if (currentDetailCarId && currentDetailCarId === id) renderVehicleDetail(id);

  showToast(`Venda concluída! Lucro apurado: ${formatMoney(car.lucro)}`);
}

// Modal Despesas
function openModalAddExpense() {
  document.getElementById('formExpense').reset();
  document.getElementById('expData').value = new Date().toISOString().slice(0, 10);
  openModal('modalExpense');
}

function openModalAddExpenseForCurrentCar() {
  openModalAddExpense();
  if (currentDetailCarId) document.getElementById('expCarSelect').value = currentDetailCarId;
}

function openModalAddExpenseForCar(carId) {
  openModalAddExpense();
  document.getElementById('expCarSelect').value = carId;
}

function handleSaveExpense(e) {
  e.preventDefault();
  const carId = Number(document.getElementById('expCarSelect').value);
  const car = appData.veiculos.find(v => Number(v.id) === carId);
  if (!car) return;

  const newExp = {
    id: Date.now(),
    veiculoId: carId,
    placa: car.placa,
    modelo: car.modelo,
    data: document.getElementById('expData').value,
    categoria: document.getElementById('expCategoria').value,
    item: document.getElementById('expItem').value.trim(),
    valor: Number(document.getElementById('expValor').value) || 0
  };

  appData.despesas.push(newExp);
  saveDatabase();
  closeModal('modalExpense');
  updateCalculations();
  renderDashboard();
  renderExpensesTable();
  if (currentDetailCarId && currentDetailCarId === carId) renderVehicleDetail(carId);

  showToast('Despesa lançada e incorporada ao custo do veículo!');
}

// Modal Documento
function openModalAddDocument() {
  document.getElementById('formDocument').reset();
  document.getElementById('docData').value = new Date().toISOString().slice(0, 10);
  openModal('modalDocument');
}

function handleSaveDocument(e) {
  e.preventDefault();
  const carId = Number(document.getElementById('docCarSelect').value);
  const car = appData.veiculos.find(v => Number(v.id) === carId);
  if (!car) return;

  const newDoc = {
    id: Date.now(),
    veiculoId: carId,
    placa: car.placa,
    modelo: car.modelo,
    tipo: document.getElementById('docTipo').value,
    link: document.getElementById('docLink').value.trim(),
    dataUpload: document.getElementById('docData').value,
    observacao: document.getElementById('docObs').value.trim()
  };

  appData.documentos.push(newDoc);
  saveDatabase();
  closeModal('modalDocument');
  renderDocumentsGrid();
  if (currentDetailCarId && currentDetailCarId === carId) renderVehicleDetail(carId);

  showToast('Documento vinculado com sucesso!');
}

function openModalAddDocumentForCurrentCar() {
  openModalAddDocument();
  if (currentDetailCarId) {
    const sel = document.getElementById('docCarSelect');
    if (sel) sel.value = currentDetailCarId;
  }
}

// ============================================================================
// MODAL 5: AJUSTAR QUANTIDADE E VALOR DE PARCELAS
// ============================================================================
function openModalEditInstallments(carId) {
  try {
    const targetId = Number(carId) || Number(currentDetailCarId);
    if (!targetId) {
      showToast('Erro: nenhum veículo selecionado.');
      return;
    }
    const car = appData.veiculos.find(v => Number(v.id) === targetId);
    if (!car) {
      showToast('Veículo não encontrado para edição de parcelas.');
      return;
    }
    if (car.status !== 'Vendido') {
      showToast('Apenas veículos vendidos com parcelamento podem ter parcelas editadas.');
      return;
    }

    document.getElementById('editInstVehId').value = car.id;
    document.getElementById('editInstCarName').textContent = `${car.marca} ${car.modelo} (${car.placa})`;
    document.getElementById('editInstCurrentPlan').textContent = `Plano atual: ${car.numParcelas || 0}x de ${formatMoney(car.valorParcela || 0)} • Entrada: ${formatMoney(car.valorEntrada || 0)} • Comprador: ${car.comprador || '-'}`;

    document.getElementById('editInstNumParcelas').value = car.numParcelas || 1;
    document.getElementById('editInstValorParcela').value = car.valorParcela || 0;
    document.getElementById('editInstValorEntrada').value = car.valorEntrada || 0;

    // Próxima data de vencimento padrão
    const nextDueDate = new Date();
    nextDueDate.setMonth(nextDueDate.getMonth() + 1);
    document.getElementById('editInstDataVencimento').value = nextDueDate.toISOString().slice(0, 10);

    recalcEditInstTotal();
    openModal('modalEditInstallments');
  } catch (err) {
    console.error('Erro ao abrir modal de edição de parcelas:', err);
    showToast('Erro ao abrir formulário de parcelas. Tente novamente.');
  }
}

function recalcEditInstTotal() {
  const n = Number(document.getElementById('editInstNumParcelas').value) || 0;
  const v = Number(document.getElementById('editInstValorParcela').value) || 0;
  const e = Number(document.getElementById('editInstValorEntrada').value) || 0;
  const total = e + (n * v);
  const el = document.getElementById('editInstTotalCalculado');
  if (el) el.textContent = formatMoney(total);
}

function handleSaveEditInstallments(e) {
  e.preventDefault();
  const carId = Number(document.getElementById('editInstVehId').value);
  const car = appData.veiculos.find(v => Number(v.id) === carId);
  if (!car) return;

  const newNum = Number(document.getElementById('editInstNumParcelas').value) || 0;
  const newVal = Number(document.getElementById('editInstValorParcela').value) || 0;
  const newEntrada = Number(document.getElementById('editInstValorEntrada').value) || 0;
  const baseDate = document.getElementById('editInstDataVencimento').value || new Date().toISOString().slice(0, 10);
  const modo = document.getElementById('editInstModo').value;

  car.numParcelas = newNum;
  car.valorParcela = newVal;
  car.valorEntrada = newEntrada;
  car.valorVenda = newEntrada + (newNum * newVal);
  car.lucro = car.valorVenda - (car.custoFinal || 0);

  let existing = appData.pagamentos.filter(p => Number(p.veiculoId) === carId);
  existing.sort((a, b) => Number(a.numeroParcela) - Number(b.numeroParcela));

  if (modo === 'redefinir_tudo') {
    // Remove todas as parcelas antigas e recria do zero
    appData.pagamentos = appData.pagamentos.filter(p => Number(p.veiculoId) !== carId);
    const startDate = new Date(baseDate);
    for (let i = 1; i <= newNum; i++) {
      const d = new Date(startDate);
      d.setMonth(d.getMonth() + (i - 1));
      const dStr = d.toISOString().slice(0, 10);
      appData.pagamentos.push({
        id: Date.now() + i,
        veiculoId: carId,
        numeroParcela: i,
        dataVencimento: dStr,
        dataPagamento: '',
        valor: newVal,
        status: 'pendente',
        mesRef: dStr.slice(0, 7)
      });
    }
  } else if (modo === 'ajustar_pendentes') {
    // Mantém as que já estão pagas
    const pagas = existing.filter(p => p.status === 'pago');
    const pagasCount = pagas.length;
    const remainingCount = Math.max(0, newNum - pagasCount);

    // Remove as pendentes antigas
    appData.pagamentos = appData.pagamentos.filter(p => !(Number(p.veiculoId) === carId && p.status !== 'pago'));

    const startDate = new Date(baseDate);
    for (let i = 1; i <= remainingCount; i++) {
      const numParc = pagasCount + i;
      const d = new Date(startDate);
      d.setMonth(d.getMonth() + (i - 1));
      const dStr = d.toISOString().slice(0, 10);
      appData.pagamentos.push({
        id: Date.now() + i + Math.floor(Math.random() * 1000),
        veiculoId: carId,
        numeroParcela: numParc,
        dataVencimento: dStr,
        dataPagamento: '',
        valor: newVal,
        status: 'pendente',
        mesRef: dStr.slice(0, 7)
      });
    }
  } else if (modo === 'adicionar_ao_fim') {
    // Adiciona novas parcelas preservando todas as existentes
    const currentMax = existing.length > 0 ? Math.max(...existing.map(p => Number(p.numeroParcela) || 0)) : 0;
    const toAdd = Math.max(0, newNum - currentMax);
    const startDate = new Date(baseDate);
    for (let i = 1; i <= toAdd; i++) {
      const numParc = currentMax + i;
      const d = new Date(startDate);
      d.setMonth(d.getMonth() + (i - 1));
      const dStr = d.toISOString().slice(0, 10);
      appData.pagamentos.push({
        id: Date.now() + i + Math.floor(Math.random() * 1000),
        veiculoId: carId,
        numeroParcela: numParc,
        dataVencimento: dStr,
        dataPagamento: '',
        valor: newVal,
        status: 'pendente',
        mesRef: dStr.slice(0, 7)
      });
    }
  }

  saveDatabase();
  closeModal('modalEditInstallments');
  updateCalculations();
  renderDashboard();
  renderInventory();
  renderPaymentsMatrix();
  renderActiveFinancings();
  if (currentDetailCarId && currentDetailCarId === carId) {
    renderVehicleDetail(carId);
    switchDetailTab('pagamentos');
  }

  showToast('Plano de parcelamento atualizado com sucesso!');
}

// ============================================================================
// MODAL 6: QUITAÇÃO DE PARCELAS / REGISTRO DE PAGAMENTO
// ============================================================================
function openModalSettlement(carId = null, targetInstallmentId = null) {
  try {
    const soldFinanced = appData.veiculos.filter(v => v.status === 'Vendido' && (v.numParcelas > 0));
    if (soldFinanced.length === 0) {
      showToast('Não há veículos com financiamento ou parcelamento cadastrados.');
      return;
    }

    // Determina o carro alvo
    let targetId = Number(carId) || Number(currentDetailCarId);
    if (!targetId || !soldFinanced.some(v => Number(v.id) === targetId)) {
      targetId = soldFinanced[0].id;
    }

    // Preenche o dropdown de veículos
    populateSettlementVehicleSelect(targetId);

    // Atualiza todo o conteúdo do modal com base no carro e parcela alvo
    updateSettlementModalContent(targetId, targetInstallmentId);

    openModal('modalSettlement');
  } catch (err) {
    console.error('Erro ao abrir modal de quitação:', err);
    showToast('Erro ao abrir formulário de quitação. Tente novamente.');
  }
}

function populateSettlementVehicleSelect(selectedId) {
  const sel = document.getElementById('settleVehSelect');
  if (!sel) return;

  const soldFinanced = appData.veiculos.filter(v => v.status === 'Vendido' && (v.numParcelas > 0));
  sel.innerHTML = soldFinanced.map(v => {
    ensureInstallmentsForCar(v);
    const pendentes = appData.pagamentos.filter(p => Number(p.veiculoId) === Number(v.id) && p.status !== 'pago');
    const saldo = pendentes.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    const pendCount = pendentes.length;
    return `<option value="${v.id}" ${Number(v.id) === Number(selectedId) ? 'selected' : ''}>
      ${v.marca} ${v.modelo} (${v.placa}) — ${pendCount > 0 ? `${pendCount} parc. em aberto (${formatMoney(saldo)})` : 'TOTALMENTE QUITADO'}
    </option>`;
  }).join('');
}

function onSettleCarSelectChange(carId) {
  updateSettlementModalContent(Number(carId));
}

function updateSettlementModalContent(carId, targetInstallmentId = null) {
  const car = appData.veiculos.find(v => Number(v.id) === Number(carId));
  if (!car) return;

  ensureInstallmentsForCar(car);

  const pendentes = appData.pagamentos.filter(p => Number(p.veiculoId) === car.id && p.status !== 'pago');
  pendentes.sort((a, b) => Number(a.numeroParcela) - Number(b.numeroParcela));

  const openBalance = pendentes.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);

  document.getElementById('settleVehId').value = car.id;
  document.getElementById('settleCarName').textContent = `${car.marca} ${car.modelo} (${car.placa})`;
  document.getElementById('settleBuyerInfo').textContent = `Comprador: ${car.comprador || 'Não informado'} • Entrada: ${formatMoney(car.valorEntrada)} • Plano: ${car.numParcelas}x de ${formatMoney(car.valorParcela)}`;
  document.getElementById('settlePendingCount').textContent = pendentes.length > 0 ? `${pendentes.length} parcelas em aberto` : 'TOTALMENTE QUITADO';
  document.getElementById('settlePendingCount').className = `status-pill ${pendentes.length > 0 ? 'upcoming' : 'pago'}`;
  document.getElementById('settleOpenBalance').textContent = formatMoney(openBalance);

  // Popula o select de parcelas individuais
  const parcSelect = document.getElementById('settleParcelaSelect');
  if (parcSelect) {
    if (pendentes.length === 0) {
      parcSelect.innerHTML = '<option value="">Nenhuma parcela pendente</option>';
    } else {
      parcSelect.innerHTML = pendentes.map(p => `
        <option value="${p.id}" data-valor="${p.valor}" data-numero="${p.numeroParcela}">
          Parcela ${p.numeroParcela} de ${car.numParcelas} • Vencimento: ${formatDate(p.dataVencimento)} • ${formatMoney(p.valor)}
        </option>
      `).join('');
    }
  }

  // Configura data padrão como hoje
  document.getElementById('settleDataPagamento').value = new Date().toISOString().slice(0, 10);

  // Se tiver parcela alvo específica
  if (targetInstallmentId && pendentes.some(p => Number(p.id) === Number(targetInstallmentId))) {
    document.getElementById('settleTipo').value = 'individual';
    if (parcSelect) parcSelect.value = targetInstallmentId;
    onSettleTipoChange('individual');
  } else {
    // Padrão: se houver apenas 1 pendente, seleciona individual; senão total
    if (pendentes.length === 1) {
      document.getElementById('settleTipo').value = 'individual';
      onSettleTipoChange('individual');
    } else {
      document.getElementById('settleTipo').value = 'total';
      onSettleTipoChange('total');
    }
  }

  const btnConfirm = document.getElementById('btnConfirmSettle');
  if (btnConfirm) {
    btnConfirm.disabled = (pendentes.length === 0);
  }
}

function onSettleTipoChange(tipo) {
  const carId = Number(document.getElementById('settleVehId').value);
  const car = appData.veiculos.find(v => Number(v.id) === carId);
  const pendentes = appData.pagamentos.filter(p => Number(p.veiculoId) === carId && p.status !== 'pago');
  pendentes.sort((a, b) => Number(a.numeroParcela) - Number(b.numeroParcela));
  const openBalance = pendentes.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);

  const blockParcela = document.getElementById('settleParcelaBlock');
  const blockQtd = document.getElementById('settleQtdBlock');
  const valInput = document.getElementById('settleValorPago');
  const valHint = document.getElementById('settleValorPagoHint');
  const nominalTag = document.getElementById('settleNominalTag');

  if (blockParcela) blockParcela.style.display = (tipo === 'individual') ? 'block' : 'none';
  if (blockQtd) blockQtd.style.display = (tipo === 'parcial_parcelas') ? 'block' : 'none';

  if (tipo === 'total') {
    valInput.value = openBalance > 0 ? openBalance.toFixed(2) : '0.00';
    if (nominalTag) nominalTag.textContent = `Saldo Nominal: ${formatMoney(openBalance)}`;
    if (valHint) valHint.textContent = `Liquida 100% das ${pendentes.length} parcelas restantes. Você pode conceder desconto e informar o valor negociado.`;
  } else if (tipo === 'individual') {
    const parcSelect = document.getElementById('settleParcelaSelect');
    const selectedOption = parcSelect ? parcSelect.options[parcSelect.selectedIndex] : null;
    const val = selectedOption ? Number(selectedOption.getAttribute('data-valor')) || (car ? car.valorParcela : 0) : (car ? car.valorParcela : 0);
    valInput.value = val ? val.toFixed(2) : '0.00';
    if (nominalTag) nominalTag.textContent = `Nominal da Parcela: ${formatMoney(val)}`;
    if (valHint) valHint.textContent = 'Informe o valor que está sendo pago para quitar esta parcela específica.';
  } else if (tipo === 'parcial_parcelas') {
    const qtdInput = document.getElementById('settleQtdParcelas');
    if (qtdInput) {
      qtdInput.max = pendentes.length || 1;
      qtdInput.value = Math.max(1, Math.min(Number(qtdInput.value) || 1, pendentes.length || 1));
    }
    onSettleQtdChange();
  } else if (tipo === 'parcial_valor') {
    valInput.value = (car && car.valorParcela) ? car.valorParcela.toFixed(2) : '1000.00';
    if (nominalTag) nominalTag.textContent = `Saldo Aberto: ${formatMoney(openBalance)}`;
    if (valHint) valHint.textContent = 'O valor informado será amortizado consecutivamente das próximas parcelas em aberto.';
  }

  recalcSettleSummary();
}

function onSettleParcelaSelectChange(parcelaId) {
  const p = appData.pagamentos.find(item => Number(item.id) === Number(parcelaId));
  const valInput = document.getElementById('settleValorPago');
  const nominalTag = document.getElementById('settleNominalTag');
  if (p && valInput) {
    valInput.value = Number(p.valor).toFixed(2);
    if (nominalTag) nominalTag.textContent = `Nominal da Parcela: ${formatMoney(p.valor)}`;
  }
  recalcSettleSummary();
}

function onSettleQtdChange() {
  const carId = Number(document.getElementById('settleVehId').value);
  const pendentes = appData.pagamentos.filter(p => Number(p.veiculoId) === carId && p.status !== 'pago');
  pendentes.sort((a, b) => Number(a.numeroParcela) - Number(b.numeroParcela));

  const qtdInput = document.getElementById('settleQtdParcelas');
  const qtd = Math.max(1, Math.min(Number(qtdInput ? qtdInput.value : 1) || 1, pendentes.length || 1));
  if (qtdInput) qtdInput.value = qtd;

  const sublist = pendentes.slice(0, qtd);
  const totalSub = sublist.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);

  const valInput = document.getElementById('settleValorPago');
  const nominalTag = document.getElementById('settleNominalTag');
  const valHint = document.getElementById('settleValorPagoHint');

  if (valInput) valInput.value = totalSub.toFixed(2);
  if (nominalTag) nominalTag.textContent = `Soma das ${qtd} parcelas: ${formatMoney(totalSub)}`;
  if (valHint) valHint.textContent = `Serão quitadas as parcelas de vencimento mais próximo (${sublist.map(p => p.numeroParcela).join(', ')}).`;

  recalcSettleSummary();
}

function recalcSettleSummary() {
  const notice = document.getElementById('settleSummaryNotice');
  if (!notice) return;

  const carId = Number(document.getElementById('settleVehId').value);
  const car = appData.veiculos.find(v => Number(v.id) === carId);
  if (!car) {
    notice.innerHTML = 'Nenhum veículo selecionado.';
    return;
  }

  const pendentes = appData.pagamentos.filter(p => Number(p.veiculoId) === carId && p.status !== 'pago');
  pendentes.sort((a, b) => Number(a.numeroParcela) - Number(b.numeroParcela));
  const openBalance = pendentes.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);

  if (pendentes.length === 0) {
    notice.innerHTML = '<strong style="color: var(--success);">✅ Este veículo não possui parcelas em aberto. Todas já foram quitadas!</strong>';
    return;
  }

  const tipo = document.getElementById('settleTipo').value;
  const valPago = Number(document.getElementById('settleValorPago').value) || 0;

  let nominalComparativo = 0;
  let descricaoAcao = '';
  let novoSaldoRestante = 0;

  if (tipo === 'total') {
    nominalComparativo = openBalance;
    descricaoAcao = `Liquidação integral de todas as ${pendentes.length} parcelas restantes.`;
    novoSaldoRestante = 0;
  } else if (tipo === 'individual') {
    const pId = Number(document.getElementById('settleParcelaSelect').value);
    const p = pendentes.find(item => Number(item.id) === pId) || pendentes[0];
    nominalComparativo = p ? Number(p.valor) : 0;
    descricaoAcao = p ? `Baixa da Parcela nº ${p.numeroParcela} (Vencimento: ${formatDate(p.dataVencimento)}).` : 'Baixa de 1 parcela.';
    novoSaldoRestante = Math.max(0, openBalance - (p ? p.valor : 0));
  } else if (tipo === 'parcial_parcelas') {
    const qtd = Math.min(Number(document.getElementById('settleQtdParcelas').value) || 1, pendentes.length);
    const sublist = pendentes.slice(0, qtd);
    nominalComparativo = sublist.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    descricaoAcao = `Quitação de ${qtd} parcela(s) consecutiva(s) (${sublist.map(p => `Nº ${p.numeroParcela}`).join(', ')}).`;
    novoSaldoRestante = Math.max(0, openBalance - nominalComparativo);
  } else if (tipo === 'parcial_valor') {
    nominalComparativo = valPago;
    descricaoAcao = `Amortização em dinheiro de ${formatMoney(valPago)} abatendo parcelas consecutivas.`;
    novoSaldoRestante = Math.max(0, openBalance - valPago);
  }

  const diff = valPago - nominalComparativo;
  let badgeDiff = '';
  if (diff < -0.01 && (tipo === 'total' || tipo === 'individual' || tipo === 'parcial_parcelas')) {
    badgeDiff = ` • <strong style="color: var(--success);">Desconto concedido: ${formatMoney(Math.abs(diff))}</strong>`;
  } else if (diff > 0.01 && (tipo === 'total' || tipo === 'individual' || tipo === 'parcial_parcelas')) {
    badgeDiff = ` • <strong style="color: var(--warning);">Acréscimo/Juros: ${formatMoney(diff)}</strong>`;
  }

  notice.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 4px;">
      <div><strong>Ação:</strong> ${descricaoAcao}</div>
      <div><strong>Valor Informado a Pagar:</strong> <span style="color: var(--success); font-weight: 700; font-size: 0.95rem;">${formatMoney(valPago)}</span>${badgeDiff}</div>
      <div><strong>Saldo Devedor Restante Após Quitação:</strong> <span style="font-weight: 700; color: ${novoSaldoRestante === 0 ? 'var(--success)' : 'var(--warning)'};">${formatMoney(novoSaldoRestante)}</span> ${novoSaldoRestante === 0 ? '🎉 (Totalmente Quitado)' : ''}</div>
    </div>
  `;
}

function handleSaveSettlement(e) {
  e.preventDefault();
  const carId = Number(document.getElementById('settleVehId').value);
  const car = appData.veiculos.find(v => Number(v.id) === carId);
  if (!car) {
    showToast('Erro: Veículo não encontrado.');
    return;
  }

  const pendentes = appData.pagamentos.filter(p => Number(p.veiculoId) === carId && p.status !== 'pago');
  pendentes.sort((a, b) => Number(a.numeroParcela) - Number(b.numeroParcela));

  if (pendentes.length === 0) {
    showToast('Todas as parcelas deste veículo já foram quitadas.');
    closeModal('modalSettlement');
    return;
  }

  const tipo = document.getElementById('settleTipo').value;
  const valPago = Number(document.getElementById('settleValorPago').value);
  if (isNaN(valPago) || valPago <= 0) {
    alert('Por favor, informe um valor a ser pago válido maior que zero.');
    return;
  }

  const dataPag = document.getElementById('settleDataPagamento').value || new Date().toISOString().slice(0, 10);
  const formaPag = document.getElementById('settleFormaPagamento').value;
  const obs = document.getElementById('settleObs').value.trim();

  if (tipo === 'individual') {
    const pId = Number(document.getElementById('settleParcelaSelect').value);
    const p = appData.pagamentos.find(item => Number(item.id) === pId);
    if (!p) {
      alert('Selecione uma parcela válida para quitar.');
      return;
    }
    p.status = 'pago';
    p.dataPagamento = dataPag;
    p.valorPago = valPago;
    p.formaPagamento = formaPag;
    p.observacao = `Quitado via ${formaPag}. Valor pago: ${formatMoney(valPago)}.${obs ? ` Obs: ${obs}` : ''}`;
    showToast(`Parcela ${p.numeroParcela} quitada no valor de ${formatMoney(valPago)}!`);
  } else if (tipo === 'total') {
    const avgPerParc = valPago / pendentes.length;
    pendentes.forEach(p => {
      p.status = 'pago';
      p.dataPagamento = dataPag;
      p.valorPago = Number(avgPerParc.toFixed(2));
      p.formaPagamento = formaPag;
      p.observacao = `Quitação Total via ${formaPag}. Negociado: ${formatMoney(valPago)}.${obs ? ` Obs: ${obs}` : ''}`;
    });
    car.quitado = true;
    car.dataQuitacao = dataPag;
    car.valorQuitacaoTotal = valPago;
    showToast(`Quitação total confirmada! Todas as parcelas foram liquidadas por ${formatMoney(valPago)}.`);
  } else if (tipo === 'parcial_parcelas') {
    const qtd = Math.min(Number(document.getElementById('settleQtdParcelas').value) || 1, pendentes.length);
    const sublist = pendentes.slice(0, qtd);
    const avgPerParc = valPago / qtd;
    sublist.forEach(p => {
      p.status = 'pago';
      p.dataPagamento = dataPag;
      p.valorPago = Number(avgPerParc.toFixed(2));
      p.formaPagamento = formaPag;
      p.observacao = `Quitação parcial (${formaPag}). Valor: ${formatMoney(valPago)}.${obs ? ` Obs: ${obs}` : ''}`;
    });
    showToast(`${qtd} parcela(s) baixada(s) com sucesso na quitação parcial!`);
  } else if (tipo === 'parcial_valor') {
    let restante = valPago;
    let baixadas = 0;
    for (let i = 0; i < pendentes.length; i++) {
      const p = pendentes[i];
      if (restante >= p.valor) {
        p.status = 'pago';
        p.dataPagamento = dataPag;
        p.valorPago = p.valor;
        p.formaPagamento = formaPag;
        p.observacao = `Amortização de parcela via ${formaPag}.${obs ? ` Obs: ${obs}` : ''}`;
        restante -= p.valor;
        baixadas++;
      } else if (restante > 0) {
        p.valor = p.valor - restante;
        p.observacao = `Amortizado ${formatMoney(restante)} nesta parcela via ${formaPag}.${obs ? ` Obs: ${obs}` : ''}`;
        restante = 0;
        break;
      }
    }
    showToast(`Amortização de ${formatMoney(valPago)} registrada com sucesso (${baixadas} parcela(s) quitada(s))!`);
  }

  saveDatabase();
  closeModal('modalSettlement');
  updateCalculations();
  renderDashboard();
  renderPaymentsMatrix();
  renderActiveFinancings();
  if (currentDetailCarId && Number(currentDetailCarId) === Number(carId)) {
    renderVehicleDetail(carId);
    switchDetailTab('pagamentos');
  }
}

function openModalRegisterPayment() {
  openModalSettlement();
}

// Busca Global
function handleGlobalSearch(term) {
  if (document.getElementById('viewInventory').style.display !== 'none') {
    renderInventory();
  } else if (document.getElementById('viewDashboard').style.display !== 'none') {
    // Se digitou no dashboard, migra para a lista de estoque filtrada
    if (term.length > 2) {
      switchView('inventory');
    }
  }
}

// ============================================================================
// EXPORTAÇÃO PARA CSV & EXCEL & BACKUP
// ============================================================================
function downloadCSV(csvContent, filename) {
  // Inclui UTF-8 BOM para que o Excel abra acentuações perfeitamente
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function exportVehiclesToCSV() {
  const headers = ['ID', 'Data da compra', 'Marca', 'Modelo', 'Ano', 'Placa', 'Sociedade', 'Antigo dono', 'Valor de compra', 'Despesas (total)', 'Custo final', 'Valor FIPE', 'Data da venda', 'Novo comprador', 'Valor de venda', 'Parcelamento', 'Valor da entrada', 'Nº de parcelas', 'Valor da parcela', 'Lucro', 'Status'];

  const rows = appData.veiculos.map(v => [
    v.id,
    v.dataCompra,
    v.marca,
    `"${v.modelo}"`,
    v.ano,
    v.placa,
    v.sociedade || '',
    `"${v.antigoDono || ''}"`,
    v.valorCompra,
    v.despesasTotal,
    v.custoFinal,
    v.valorFipe,
    v.dataVenda || '',
    `"${v.comprador || ''}"`,
    v.valorVenda || '',
    v.parcelamento || '',
    v.valorEntrada || '',
    v.numParcelas || '',
    v.valorParcela || '',
    v.lucro || '',
    v.status
  ]);

  const csv = [headers.join(';')].concat(rows.map(r => r.join(';'))).join('\n');
  downloadCSV(csv, `Controle_de_Carros_Toledo_${new Date().toISOString().slice(0, 10)}.csv`);
  showToast('Planilha de veículos exportada com sucesso!');
}

function exportExpensesToCSV() {
  const headers = ['ID', 'ID do veiculo', 'Placa', 'Modelo', 'Data da despesa', 'Categoria', 'Item / Descricao', 'Valor'];

  const rows = appData.despesas.map(d => {
    const car = appData.veiculos.find(v => Number(v.id) === Number(d.veiculoId));
    return [
      d.id,
      d.veiculoId,
      car ? car.placa : (d.placa || ''),
      `"${car ? car.modelo : (d.modelo || '')}"`,
      d.data,
      `"${d.categoria || ''}"`,
      `"${d.item || ''}"`,
      d.valor
    ];
  });

  const csv = [headers.join(';')].concat(rows.map(r => r.join(';'))).join('\n');
  downloadCSV(csv, `Despesas_Toledo_${new Date().toISOString().slice(0, 10)}.csv`);
  showToast('Planilha de despesas exportada!');
}

function exportDocumentsToCSV() {
  const headers = ['ID', 'ID do veiculo', 'Placa', 'Modelo', 'Tipo de documento', 'Link do arquivo', 'Data de upload', 'Observacao'];

  const rows = appData.documentos.map(doc => {
    const car = appData.veiculos.find(v => Number(v.id) === Number(doc.veiculoId));
    return [
      doc.id,
      doc.veiculoId,
      car ? car.placa : (doc.placa || ''),
      `"${car ? car.modelo : (doc.modelo || '')}"`,
      doc.tipo,
      `"${doc.link}"`,
      doc.dataUpload,
      `"${doc.observacao || ''}"`
    ];
  });

  const csv = [headers.join(';')].concat(rows.map(r => r.join(';'))).join('\n');
  downloadCSV(csv, `Documentos_Toledo_${new Date().toISOString().slice(0, 10)}.csv`);
  showToast('Planilha de documentos exportada!');
}

function exportFullJSONBackup() {
  const jsonStr = JSON.stringify(appData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Backup_AutoManage_Toledo_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('Backup JSON gerado e salvo!');
}

function importJSONBackup(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported.veiculos && Array.isArray(imported.veiculos)) {
        appData = imported;
        saveDatabase();
        initApp();
        showToast('Backup importado com sucesso!');
      } else {
        alert('Arquivo de backup inválido.');
      }
    } catch (err) {
      alert('Erro ao interpretar o arquivo JSON.');
    }
  };
  reader.readAsText(file);
}

// ============================================================================
// IMPRESSÃO E RELATÓRIOS
// ============================================================================
function printReport() {
  window.print();
}

function printPaymentReceipt() {
  window.print();
}

function printSingleCarCarnet(carId) {
  viewCarDetail(carId, 'pagamentos');
  setTimeout(() => window.print(), 300);
}
