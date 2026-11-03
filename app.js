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
// Período do dashboard: tipo = 'dia' | 'semana' | 'mes' | 'ano' | 'tudo' | 'personalizado'
let dashboardPeriod = { tipo: 'tudo', inicio: '', fim: '' };

// ============================================================================
// COMUNICAÇÃO COM O SERVIDOR (API)
// ============================================================================
let currentUser = null;      // { id, nome, login, perfil }
let dataVersion = 0;         // versão dos dados no servidor (controle de concorrência)
let availableSocios = [];    // usuários que podem ser sócios de um veículo
let dataOrigin = '';         // 'planilha' quando o servidor ainda está com a base original

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    body = null;
  }
  if (!res.ok) {
    const err = new Error((body && body.erro) || `Erro ${res.status} ao comunicar com o servidor.`);
    err.status = res.status;
    err.body = body;
    if (res.status === 401 && !url.startsWith('/api/auth')) handleSessionExpired();
    throw err;
  }
  return body;
}

function isFullUser() {
  return !!currentUser && currentUser.perfil === 'full';
}

// Bloqueia ações de edição para o perfil de visualização
function requireFullAccess() {
  if (isFullUser()) return true;
  showToast('Seu perfil é somente de visualização.');
  return false;
}

// ============================================================================
// REPOSITÓRIO DIGITAL DE ARQUIVOS E FOTOS (ARMAZENADO NO SERVIDOR)
// ============================================================================
const AppFileRepo = {
  async init() {
    return true;
  },

  async salvar(id, fileData) {
    try {
      await apiFetch(`/api/arquivos/${Number(id)}`, { method: 'PUT', body: JSON.stringify(fileData) });
      return true;
    } catch (err) {
      console.error('Erro ao enviar arquivo:', err);
      showToast(err.message);
      return false;
    }
  },

  async obter(id) {
    try {
      return await apiFetch(`/api/arquivos/${Number(id)}`);
    } catch (err) {
      return null;
    }
  },

  async excluir(id) {
    try {
      await apiFetch(`/api/arquivos/${Number(id)}`, { method: 'DELETE' });
      return true;
    } catch (err) {
      return false;
    }
  },

  async calcularTotalBytes() {
    try {
      const { totalBytes } = await apiFetch('/api/arquivos-total');
      return Number(totalBytes) || 0;
    } catch (err) {
      return 0;
    }
  }
};

let cameraStream = null;
let currentCameraFacing = 'environment'; // 'environment' (traseira) ou 'user' (frontal)

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  bootAuth();
});

// ============================================================================
// LOGIN E SESSÃO
// ============================================================================
async function bootAuth() {
  try {
    const status = await apiFetch('/api/auth/status');
    if (status.usuario) {
      await startSession(status.usuario);
    } else {
      showAuthScreen();
    }
  } catch (err) {
    showAuthScreen('Não foi possível conectar ao servidor. Verifique se ele está rodando (npm start).');
  }
}

function showAuthScreen(errorMessage = '') {
  document.body.classList.add('auth-locked');
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('authLoginForm').style.display = 'flex';
  document.getElementById('authSubtitle').textContent = 'Entre com seu login e senha.';
  setAuthError(errorMessage);
  setTimeout(() => document.getElementById('loginUsuario').focus(), 50);
}

function setAuthError(message) {
  const box = document.getElementById('authError');
  box.textContent = message;
  box.style.display = message ? 'block' : 'none';
}

function hideAuthScreen() {
  document.body.classList.remove('auth-locked');
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('authLoginForm').reset();
  setAuthError('');
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('btnLogin');
  btn.disabled = true;
  try {
    const { usuario } = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        login: document.getElementById('loginUsuario').value.trim(),
        senha: document.getElementById('loginSenha').value
      })
    });
    await startSession(usuario);
  } catch (err) {
    setAuthError(err.message);
    document.getElementById('loginSenha').value = '';
  } finally {
    btn.disabled = false;
  }
}

async function startSession(usuario) {
  currentUser = usuario;
  applyUserInterface();

  // Senha padrão ou provisória: troca obrigatória antes de liberar o sistema
  if (currentUser.trocarSenha) {
    document.getElementById('authLoginForm').style.display = 'none';
    document.getElementById('authSubtitle').textContent = 'Defina uma nova senha para continuar.';
    setAuthError('');
    openModalChangePassword(true);
    return;
  }

  try {
    await loadDatabase();
  } catch (err) {
    if (err.status !== 401) showAuthScreen(err.message);
    return;
  }
  hideAuthScreen();
  initApp();
  switchView('dashboard');
  await offerBrowserDataImport();
}

async function logout() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    // Mesmo sem resposta do servidor a sessão local é encerrada
  }
  window.location.reload();
}

function handleSessionExpired() {
  if (!currentUser) return;
  currentUser = null;
  showAuthScreen('Sua sessão expirou. Entre novamente.');
}

// Ajusta cabeçalho, menu e permissões conforme o perfil do usuário logado
function applyUserInterface() {
  const full = isFullUser();
  document.body.classList.toggle('perfil-visualizacao', !full);
  document.getElementById('userAvatar').textContent = (currentUser.nome || '?').trim().charAt(0).toUpperCase();
  document.getElementById('userName').textContent = currentUser.nome;
  document.getElementById('userRole').textContent = full ? 'Acesso total' : 'Visualização (sócio)';
  document.getElementById('navUsers').style.display = full ? '' : 'none';
}

// forced = true: troca obrigatória (senha padrão/provisória), sem opção de cancelar
function openModalChangePassword(forced = false) {
  const modal = document.getElementById('modalChangePassword');
  document.getElementById('formChangePassword').reset();
  modal.dataset.locked = forced ? '1' : '';
  document.getElementById('pwdTitle').textContent = forced ? 'Defina Sua Nova Senha' : 'Alterar Minha Senha';
  document.getElementById('pwdForcedNotice').style.display = forced ? 'block' : 'none';
  document.getElementById('pwdCloseBtn').style.display = forced ? 'none' : '';
  document.getElementById('pwdCancelBtn').textContent = forced ? 'Sair' : 'Cancelar';
  document.getElementById('pwdCancelBtn').onclick = forced ? logout : () => closeModal('modalChangePassword');
  openModal('modalChangePassword');
  setTimeout(() => document.getElementById('pwdAtual').focus(), 50);
}

async function handleChangePassword(e) {
  e.preventDefault();
  const novaSenha = document.getElementById('pwdNova').value;
  if (novaSenha !== document.getElementById('pwdConfirma').value) {
    alert('A nova senha e a confirmação não conferem.');
    return;
  }
  try {
    await apiFetch('/api/auth/senha', {
      method: 'POST',
      body: JSON.stringify({ senhaAtual: document.getElementById('pwdAtual').value, novaSenha })
    });
  } catch (err) {
    alert(err.message);
    return;
  }

  const modal = document.getElementById('modalChangePassword');
  const wasForced = modal.dataset.locked === '1';
  modal.dataset.locked = '';
  closeModal('modalChangePassword');
  showToast('Senha alterada com sucesso!');

  if (wasForced) {
    currentUser = { ...currentUser, trocarSenha: false };
    await startSession(currentUser);
  }
}

// ============================================================================
// CADASTRO DE USUÁRIOS (SOMENTE PERFIL FULL)
// ============================================================================
let usersCache = [];

async function renderUsersView() {
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--text-dim);">Carregando...</td></tr>';
  try {
    usersCache = await apiFetch('/api/usuarios');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--danger);">${escapeHtml(err.message)}</td></tr>`;
    return;
  }

  tbody.innerHTML = usersCache.map(u => `
    <tr>
      <td><strong>${escapeHtml(u.nome)}</strong>${u.id === currentUser.id ? ' <span style="font-size: 0.75rem; color: var(--text-dim);">(você)</span>' : ''}</td>
      <td>${escapeHtml(u.login)}</td>
      <td><span class="status-pill ${u.perfil === 'full' ? 'pago' : 'upcoming'}">${u.perfil === 'full' ? 'Acesso total' : 'Visualização'}</span></td>
      <td>${u.veiculosComoSocio} veículo(s)</td>
      <td>
        <span class="status-pill ${u.ativo ? 'pago' : 'atrasado'}">${u.ativo ? 'Ativo' : 'Inativo'}</span>
        ${u.trocarSenha ? '<span class="status-pill pendente" title="Ainda não trocou a senha provisória">Senha provisória</span>' : ''}
      </td>
      <td>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button class="btn btn-secondary btn-sm" onclick="openModalUser(${u.id})">Editar</button>
          ${u.id === currentUser.id ? '' : `<button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id})">Excluir</button>`}
        </div>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--text-dim);">Nenhum usuário cadastrado.</td></tr>';
}

function openModalUser(userId = null) {
  const user = usersCache.find(u => u.id === Number(userId)) || null;
  document.getElementById('formUser').reset();
  document.getElementById('userId').value = user ? user.id : '';
  document.getElementById('modalUserTitle').textContent = user ? `Editar Usuário — ${user.nome}` : 'Novo Usuário';
  document.getElementById('userNome').value = user ? user.nome : '';
  document.getElementById('userLogin').value = user ? user.login : '';
  document.getElementById('userPerfil').value = user ? user.perfil : 'visualizacao';
  document.getElementById('userAtivo').checked = user ? user.ativo : true;
  document.getElementById('userSenha').required = !user;
  document.getElementById('userSenhaHint').textContent = user
    ? 'Deixe em branco para manter a senha atual. Se preencher, ela é provisória: o usuário troca no próximo login.'
    : 'Senha provisória (mínimo 6 caracteres): o usuário define a dele no primeiro login.';
  document.getElementById('userAtivoGroup').style.display = user && user.id === currentUser.id ? 'none' : '';
  openModal('modalUser');
}

async function handleSaveUser(e) {
  e.preventDefault();
  const id = Number(document.getElementById('userId').value) || null;
  const senha = document.getElementById('userSenha').value;
  const payload = {
    nome: document.getElementById('userNome').value.trim(),
    login: document.getElementById('userLogin').value.trim(),
    perfil: document.getElementById('userPerfil').value,
    ativo: document.getElementById('userAtivo').checked
  };
  if (senha) payload.senha = senha;

  try {
    await apiFetch(id ? `/api/usuarios/${id}` : '/api/usuarios', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
  } catch (err) {
    alert(err.message);
    return;
  }

  closeModal('modalUser');
  showToast(id ? 'Usuário atualizado!' : 'Usuário cadastrado!');
  if (id === currentUser.id) {
    currentUser = { ...currentUser, nome: payload.nome, login: payload.login, perfil: payload.perfil };
    applyUserInterface();
  }
  // Recarrega dados: o nome do sócio e os vínculos de sociedade podem ter mudado
  await reloadFromServer();
  if (isFullUser()) renderUsersView();
  else switchView('dashboard');
}

async function deleteUser(userId) {
  const user = usersCache.find(u => u.id === Number(userId));
  if (!user) return;
  const aviso = user.veiculosComoSocio > 0
    ? `\n\n${user.veiculosComoSocio} veículo(s) deste sócio passarão a ficar sem sócio.`
    : '';
  if (!confirm(`Excluir o usuário "${user.nome}"?${aviso}`)) return;
  try {
    await apiFetch(`/api/usuarios/${user.id}`, { method: 'DELETE' });
  } catch (err) {
    alert(err.message);
    return;
  }
  showToast('Usuário excluído.');
  await reloadFromServer();
  renderUsersView();
}

// ============================================================================
// MIGRAÇÃO: DADOS QUE FICAVAM SALVOS SOMENTE NESTE NAVEGADOR
// ============================================================================
const LEGACY_MIGRATION_KEY = 'automanage_toledo_migrado_servidor';

function readLegacyIndexedDBFiles() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('AutoManageRepoDB_v1');
      req.onerror = () => resolve([]);
      req.onsuccess = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains('arquivos')) {
          database.close();
          resolve([]);
          return;
        }
        const getAll = database.transaction(['arquivos'], 'readonly').objectStore('arquivos').getAll();
        getAll.onsuccess = (ev) => {
          database.close();
          resolve(ev.target.result || []);
        };
        getAll.onerror = () => {
          database.close();
          resolve([]);
        };
      };
    } catch (err) {
      resolve([]);
    }
  });
}

async function offerBrowserDataImport() {
  if (!isFullUser() || dataOrigin !== 'planilha') return;

  let legacy = null;
  try {
    if (localStorage.getItem(LEGACY_MIGRATION_KEY)) return;
    legacy = JSON.parse(localStorage.getItem(DB_STORAGE_KEY) || 'null');
  } catch (e) {
    return;
  }
  if (!legacy || !Array.isArray(legacy.veiculos)) return;

  const ok = confirm(
    `Este navegador tem dados salvos da versão anterior do sistema (${legacy.veiculos.length} veículos, ` +
    `${(legacy.despesas || []).length} despesas, ${(legacy.documentos || []).length} documentos).\n\n` +
    'Deseja enviar esses dados para o servidor? Eles substituirão a base original da planilha que está no servidor.'
  );
  try {
    localStorage.setItem(LEGACY_MIGRATION_KEY, new Date().toISOString());
  } catch (e) {
    // Sem localStorage a pergunta apenas reaparece no próximo login
  }
  if (!ok) return;

  appData = {
    veiculos: legacy.veiculos || [],
    despesas: legacy.despesas || [],
    documentos: legacy.documentos || [],
    pagamentos: legacy.pagamentos || []
  };

  const files = await readLegacyIndexedDBFiles();
  const docIds = new Set(appData.documentos.map(d => Number(d.id)));
  let enviados = 0;
  for (const file of files) {
    if (docIds.has(Number(file.id)) && await AppFileRepo.salvar(file.id, file)) enviados++;
  }

  saveDatabase();
  initApp();
  showToast(`Dados do navegador enviados ao servidor (${appData.veiculos.length} veículos, ${enviados} arquivos).`);
}

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

// Carrega do servidor somente os dados que o usuário logado pode ver
async function loadDatabase() {
  const dados = await apiFetch('/api/dados');
  appData = {
    veiculos: dados.veiculos || [],
    despesas: dados.despesas || [],
    documentos: dados.documentos || [],
    pagamentos: dados.pagamentos || []
  };
  dataVersion = Number(dados.versao) || 0;
  availableSocios = dados.socios || [];
  dataOrigin = dados.origem || '';
}

// Salvamentos são enviados em fila: alterações seguidas viram um único envio
let saveInFlight = null;
let savePending = false;

function saveDatabase() {
  updateBadgesAndSelects();
  if (!isFullUser()) return;
  savePending = true;
  if (!saveInFlight) saveInFlight = flushSaveQueue();
}

async function flushSaveQueue() {
  try {
    while (savePending) {
      savePending = false;
      const { versao } = await apiFetch('/api/dados', {
        method: 'PUT',
        body: JSON.stringify({ ...appData, versao: dataVersion })
      });
      dataVersion = versao;
    }
  } catch (err) {
    savePending = false;
    if (err.status === 409) {
      alert('Os dados foram alterados por outro usuário enquanto você editava. A tela será atualizada com a versão mais recente; refaça a sua última alteração.');
      await reloadFromServer();
    } else if (err.status !== 401) {
      alert(`Não foi possível salvar no servidor: ${err.message}`);
    }
  } finally {
    saveInFlight = null;
  }
}

async function reloadFromServer() {
  try {
    await loadDatabase();
    initApp();
    if (currentDetailCarId && appData.veiculos.some(v => Number(v.id) === Number(currentDetailCarId))) {
      renderVehicleDetail(currentDetailCarId);
    }
  } catch (err) {
    console.error('Erro ao recarregar dados:', err);
  }
}

async function resetToSpreadsheetDefaults() {
  if (!requireFullAccess()) return;
  if (confirm('Deseja realmente restaurar todos os dados para a planilha original Toledo_v2? Todas as alterações feitas no sistema serão perdidas para TODOS os usuários.')) {
    try {
      await apiFetch('/api/dados/restaurar-planilha', { method: 'POST' });
      await reloadFromServer();
      showToast('Base restaurada com sucesso a partir da planilha Toledo_v2!');
    } catch (err) {
      alert(err.message);
    }
  }
}

let repoDropzoneReady = false;

function initApp() {
  if (!repoDropzoneReady) {
    setupRepoDropzoneEvents();
    repoDropzoneReady = true;
  }
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

function formatBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num === 0) return '0 KB';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
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

  populateSocioFilter();
}

// Filtro de sócios do estoque: usuários vinculados + sociedades em texto ainda não vinculadas
function populateSocioFilter() {
  const filterSociedade = document.getElementById('filterSociedade');
  if (!filterSociedade) return;
  const currentVal = filterSociedade.value;

  const socios = new Map();
  availableSocios.forEach(s => socios.set(`socio:${s.id}`, s.nome));
  appData.veiculos.forEach(v => {
    if (v.socioId) socios.set(`socio:${v.socioId}`, v.sociedade || `Sócio #${v.socioId}`);
    else if (v.sociedade) socios.set(`texto:${v.sociedade}`, `${v.sociedade} (sem usuário)`);
  });

  filterSociedade.innerHTML = '<option value="todos">Todos os Sócios</option>' +
    [...socios.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([valor, nome]) => `<option value="${escapeHtml(valor)}">Sócio: ${escapeHtml(nome)}</option>`)
      .join('') +
    '<option value="sem_sociedade">Próprio (sem sócio)</option>';

  filterSociedade.value = [...filterSociedade.options].some(o => o.value === currentVal) ? currentVal : 'todos';
}

// Campo "Sócio" do cadastro de veículo, preenchido a partir do cadastro de usuários
function populateVehicleSocioSelect(car = null) {
  const select = document.getElementById('vehSocio');
  if (!select) return;

  const options = ['<option value="">Próprio (sem sócio)</option>'];
  availableSocios.forEach(s => {
    options.push(`<option value="${s.id}">${escapeHtml(s.nome)}${s.perfil === 'full' ? ' (acesso total)' : ''}</option>`);
  });

  // Sócio vinculado a usuário que não aparece na lista (ex: desativado)
  if (car && car.socioId && !availableSocios.some(s => Number(s.id) === Number(car.socioId))) {
    options.push(`<option value="${car.socioId}">${escapeHtml(car.sociedade || `Usuário #${car.socioId}`)} (inativo)</option>`);
  }
  // Registro antigo com sociedade em texto e sem usuário vinculado
  const legado = car && !car.socioId && car.sociedade;
  if (legado) {
    options.push(`<option value="legado">${escapeHtml(car.sociedade)} (sem usuário cadastrado)</option>`);
  }
  select.innerHTML = options.join('');
  select.value = legado ? 'legado' : (car && car.socioId ? String(car.socioId) : '');

  const hint = document.getElementById('vehSocioHint');
  if (hint) {
    hint.textContent = car && !car.socioId && car.sociedade
      ? `Registro antigo com sociedade "${car.sociedade}" sem usuário vinculado. Cadastre um usuário com esse nome ou escolha um sócio.`
      : 'O sócio com perfil de visualização enxerga somente os carros vinculados a ele.';
  }
}

// ============================================================================
// NAVEGAÇÃO ENTRE TELAS
// ============================================================================
function switchView(viewName) {
  if (viewName === 'users' && !requireFullAccess()) return;
  const views = ['viewDashboard', 'viewInventory', 'viewExpenses', 'viewDocuments', 'viewPayments', 'viewVehicleDetail', 'viewBackup', 'viewUsers'];
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = 'none';
  });

  const navs = ['navDashboard', 'navInventory', 'navExpenses', 'navDocuments', 'navPayments', 'navBackup', 'navUsers'];
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
  } else if (viewName === 'users') {
    document.getElementById('viewUsers').style.display = 'block';
    document.getElementById('navUsers').classList.add('active');
    renderUsersView();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================================
// DASHBOARD VIEW
// ============================================================================
function toISODateLocal(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseISODateLocal(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// Calcula o intervalo [inicio, fim] (YYYY-MM-DD) do período que contém a data de referência
function computePeriodRange(tipo, refDate) {
  const ref = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  if (tipo === 'dia') {
    return { inicio: toISODateLocal(ref), fim: toISODateLocal(ref) };
  }
  if (tipo === 'semana') {
    // Semana de segunda a domingo
    const offset = (ref.getDay() + 6) % 7;
    const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - offset);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return { inicio: toISODateLocal(start), fim: toISODateLocal(end) };
  }
  if (tipo === 'mes') {
    const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
    return { inicio: toISODateLocal(start), fim: toISODateLocal(end) };
  }
  if (tipo === 'ano') {
    return { inicio: `${ref.getFullYear()}-01-01`, fim: `${ref.getFullYear()}-12-31` };
  }
  return { inicio: '', fim: '' };
}

function setDashboardPeriod(tipo) {
  dashboardPeriod = { tipo, ...computePeriodRange(tipo, new Date()) };
  renderDashboard();
}

function shiftDashboardPeriod(direction) {
  const { tipo, inicio, fim } = dashboardPeriod;
  if (tipo === 'tudo' || !inicio) return;

  const ref = parseISODateLocal(inicio);
  if (tipo === 'personalizado') {
    // Desloca o intervalo livre pelo seu próprio tamanho
    const end = parseISODateLocal(fim || inicio);
    const spanDays = Math.round((end - ref) / 86400000) + 1;
    const newStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + spanDays * direction);
    const newEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + spanDays * direction);
    dashboardPeriod = { tipo, inicio: toISODateLocal(newStart), fim: toISODateLocal(newEnd) };
  } else {
    if (tipo === 'dia') ref.setDate(ref.getDate() + direction);
    if (tipo === 'semana') ref.setDate(ref.getDate() + 7 * direction);
    if (tipo === 'mes') ref.setMonth(ref.getMonth() + direction);
    if (tipo === 'ano') ref.setFullYear(ref.getFullYear() + direction);
    dashboardPeriod = { tipo, ...computePeriodRange(tipo, ref) };
  }
  renderDashboard();
}

function onDashboardCustomRange() {
  let inicio = document.getElementById('dashDateFrom').value;
  let fim = document.getElementById('dashDateTo').value;
  if (!inicio && !fim) {
    setDashboardPeriod('tudo');
    return;
  }
  if (inicio && fim && inicio > fim) [inicio, fim] = [fim, inicio];
  dashboardPeriod = { tipo: 'personalizado', inicio, fim };
  renderDashboard();
}

function isDateInDashboardPeriod(dateStr) {
  const { tipo, inicio, fim } = dashboardPeriod;
  if (tipo === 'tudo') return true;
  if (!dateStr) return false;
  const day = String(dateStr).slice(0, 10);
  return (!inicio || day >= inicio) && (!fim || day <= fim);
}

function getDashboardPeriodLabel() {
  const { tipo, inicio, fim } = dashboardPeriod;
  if (tipo === 'tudo') return 'Todo o período';
  if (tipo === 'dia') {
    const label = parseISODateLocal(inicio).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  if (tipo === 'semana') return `Semana ${formatDate(inicio).slice(0, 5)} a ${formatDate(fim)}`;
  if (tipo === 'mes') {
    const label = parseISODateLocal(inicio).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  if (tipo === 'ano') return inicio.slice(0, 4);
  if (inicio && fim) return `${formatDate(inicio)} a ${formatDate(fim)}`;
  return inicio ? `A partir de ${formatDate(inicio)}` : `Até ${formatDate(fim)}`;
}

function syncDashboardPeriodControls() {
  document.querySelectorAll('#dashPeriodToggle .view-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === dashboardPeriod.tipo);
  });
  const label = document.getElementById('dashPeriodLabel');
  if (label) label.textContent = getDashboardPeriodLabel();

  const canShift = dashboardPeriod.tipo !== 'tudo' && !!dashboardPeriod.inicio && !!dashboardPeriod.fim;
  const prev = document.getElementById('dashPeriodPrev');
  const next = document.getElementById('dashPeriodNext');
  if (prev) prev.disabled = !canShift;
  if (next) next.disabled = !canShift;

  const from = document.getElementById('dashDateFrom');
  const to = document.getElementById('dashDateTo');
  if (from) from.value = dashboardPeriod.inicio;
  if (to) to.value = dashboardPeriod.fim;
}

function renderDashboard() {
  updateCalculations();
  syncDashboardPeriodControls();

  // KPIs — estoque é sempre a posição atual; vendas, lucro e despesas seguem o período filtrado
  const inStockCars = appData.veiculos.filter(v => v.status !== 'Vendido');
  const soldCars = appData.veiculos.filter(v => v.status === 'Vendido' && isDateInDashboardPeriod(v.dataVenda));
  const despesasPeriodo = appData.despesas.filter(d => isDateInDashboardPeriod(d.data));

  const totalEstoqueCusto = inStockCars.reduce((acc, v) => acc + (v.custoFinal || 0), 0);
  const totalLucro = soldCars.reduce((acc, v) => acc + (v.lucro || 0), 0);
  const totalCustoVendidos = soldCars.reduce((acc, v) => acc + (v.custoFinal || 0), 0);
  const totalVendasValor = soldCars.reduce((acc, v) => acc + (Number(v.valorVenda) || 0), 0);
  const totalDespesas = despesasPeriodo.reduce((acc, d) => acc + (Number(d.valor) || 0), 0);
  const rentabilidade = totalCustoVendidos > 0 ? Math.round((totalLucro / totalCustoVendidos) * 100) : 0;

  document.getElementById('kpiEstoqueValor').textContent = formatMoney(totalEstoqueCusto);
  document.getElementById('kpiEstoqueCount').textContent = `${inStockCars.length} veículos em pátio (posição atual)`;

  document.getElementById('kpiLucroTotal').textContent = formatMoney(totalLucro);
  document.getElementById('kpiLucroBadge').textContent = `${rentabilidade >= 0 ? '+' : ''}${rentabilidade}% rentabilidade média`;
  document.getElementById('kpiCarrosVendidos').textContent = soldCars.length;
  document.getElementById('kpiVendaTotalValor').textContent = `${formatMoney(totalVendasValor)} em vendas`;

  document.getElementById('kpiDespesasTotal').textContent = formatMoney(totalDespesas);
  document.getElementById('kpiDespesasCount').textContent = `${despesasPeriodo.length} despesas lançadas`;

  renderOverdueKpi();

  // Veículos de destaque no dashboard
  const container = document.getElementById('dashboardVehiclesGrid');
  if (container) {
    const featured = appData.veiculos.slice(0, 4);
    container.innerHTML = featured.map(v => createVehicleCardHtml(v)).join('');
  }

  // Gráficos
  renderDashboardCharts();
}

// Parcela em atraso: não paga e com vencimento anterior a hoje
function isInstallmentOverdue(p) {
  return p.status !== 'pago' && !!p.dataVencimento && p.dataVencimento < toISODateLocal(new Date());
}

// Atraso é sempre a posição de hoje, independente do período filtrado
function getOverdueSummary() {
  const byCar = new Map();
  appData.pagamentos.filter(isInstallmentOverdue).forEach(p => {
    const car = appData.veiculos.find(v => Number(v.id) === Number(p.veiculoId));
    if (!car) return;
    const entry = byCar.get(car.id) || { car, parcelas: 0, valor: 0, maisAntiga: p.dataVencimento };
    entry.parcelas += 1;
    entry.valor += Number(p.valor) || 0;
    if (p.dataVencimento < entry.maisAntiga) entry.maisAntiga = p.dataVencimento;
    byCar.set(car.id, entry);
  });
  const cars = [...byCar.values()].sort((a, b) => a.maisAntiga.localeCompare(b.maisAntiga));
  return {
    cars,
    parcelas: cars.reduce((acc, c) => acc + c.parcelas, 0),
    valor: cars.reduce((acc, c) => acc + c.valor, 0)
  };
}

function renderOverdueKpi() {
  const { cars, parcelas, valor } = getOverdueSummary();
  const badge = document.getElementById('kpiAtrasoBadge');
  const card = document.getElementById('kpiAtrasoCard');
  const value = document.getElementById('kpiAtrasoCarros');

  value.textContent = cars.length;
  value.style.color = cars.length > 0 ? 'var(--danger)' : '';

  if (cars.length === 0) {
    badge.textContent = 'Nenhuma parcela vencida';
    badge.className = 'kpi-footer-badge badge-positive';
    card.title = 'Ver controle de pagamentos';
  } else {
    badge.textContent = `${parcelas} parcela(s) • ${formatMoney(valor)} vencido`;
    badge.className = 'kpi-footer-badge badge-negative';
    card.title = 'Em atraso:\n' + cars.map(c =>
      `• ${c.car.marca} ${c.car.modelo} (${c.car.placa}) — ${c.car.comprador || 'Comprador não informado'}: ${c.parcelas} parcela(s), ${formatMoney(c.valor)}, desde ${formatDate(c.maisAntiga)}`
    ).join('\n') + '\n\nClique para ver o controle de pagamentos.';
  }
}

function renderDashboardCharts() {
  const ctxLucro = document.getElementById('chartLucroCarros');
  const ctxCat = document.getElementById('chartCategoriasDespesas');

  if (ctxLucro) {
    if (chartLucroInstance) chartLucroInstance.destroy();

    // Comparativo de carros vendidos no período: Custo Final vs Venda
    const sold = appData.veiculos.filter(v => v.status === 'Vendido' && isDateInDashboardPeriod(v.dataVenda));
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

    // Agrupamento por categoria (despesas do período)
    const catMap = {};
    appData.despesas.filter(d => isDateInDashboardPeriod(d.data)).forEach(d => {
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
    // Sócio (usuário cadastrado) ou sociedade em texto de registros antigos
    if (socFilter === 'sem_sociedade' && (v.socioId || v.sociedade)) return false;
    if (socFilter.startsWith('socio:') && Number(v.socioId) !== Number(socFilter.slice(6))) return false;
    if (socFilter.startsWith('texto:') && (v.socioId || v.sociedade !== socFilter.slice(6))) return false;

    // Busca textual
    if (searchTerm) {
      const match =
        (v.modelo || '').toLowerCase().includes(searchTerm) ||
        (v.marca || '').toLowerCase().includes(searchTerm) ||
        (v.placa || '').toLowerCase().includes(searchTerm) ||
        (v.comprador || '').toLowerCase().includes(searchTerm) ||
        (v.antigoDono || '').toLowerCase().includes(searchTerm) ||
        (v.renavam || '').toLowerCase().includes(searchTerm) ||
        (v.chassi || v.chassis || '').toLowerCase().includes(searchTerm) ||
        (v.observacoes || '').toLowerCase().includes(searchTerm);
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
              <button class="btn btn-secondary btn-sm admin-only" onclick="openModalContract(${v.id})" title="Gerar Contrato (.docx)">📄 Contrato</button>
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
          <button class="btn btn-secondary btn-sm admin-only" onclick="openModalContract(${v.id})" title="Gerar Contrato (.docx)">📄 Contrato</button>
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

  const specRenavam = document.getElementById('detailSpecRenavam');
  if (specRenavam) specRenavam.textContent = car.renavam || '-';

  const specChassi = document.getElementById('detailSpecChassi');
  if (specChassi) specChassi.textContent = car.chassi || car.chassis || '-';

  const obsBox = document.getElementById('detailObsBox');
  const specObs = document.getElementById('detailSpecObs');
  if (obsBox && specObs) {
    if (car.observacoes && car.observacoes.trim()) {
      specObs.textContent = car.observacoes.trim();
      obsBox.style.display = 'block';
    } else {
      obsBox.style.display = 'none';
    }
  }

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
    const btnRevert = document.getElementById('btnRevertSaleAction');
    if (btnRevert) btnRevert.style.display = 'inline-flex';
  } else {
    vendaRow.style.display = 'none';
    lucroRow.style.display = 'none';
    btnSell.style.display = 'inline-flex';
    const btnRevert = document.getElementById('btnRevertSaleAction');
    if (btnRevert) btnRevert.style.display = 'none';
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
      <td>${isInstallmentOverdue(p)
        ? '<span class="status-pill atrasado">ATRASADO</span>'
        : `<span class="status-pill ${p.status === 'pago' ? 'pago' : 'pendente'}">${p.status.toUpperCase()}</span>`}</td>
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
  if (!requireFullAccess()) return;
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
  if (!requireFullAccess()) return;
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
// REPOSITÓRIO DIGITAL DE DOCUMENTOS & FOTOS
// ============================================================================
async function renderDocumentsGrid() {
  const vehFilter = document.getElementById('filterDocVehicle') ? document.getElementById('filterDocVehicle').value : 'todos';
  const typeFilter = document.getElementById('filterDocType') ? document.getElementById('filterDocType').value : 'todos';
  const originFilter = document.getElementById('filterDocOrigin') ? document.getElementById('filterDocOrigin').value : 'todos';

  let list = appData.documentos;

  if (vehFilter !== 'todos') {
    list = list.filter(d => Number(d.veiculoId) === Number(vehFilter));
  }
  if (typeFilter !== 'todos') {
    list = list.filter(d => d.tipo === typeFilter);
  }
  if (originFilter !== 'todos') {
    if (originFilter === 'camera') {
      list = list.filter(d => d.origem === 'camera');
    } else if (originFilter === 'upload') {
      list = list.filter(d => d.origem === 'upload' || (d.temArquivoLocal && d.origem !== 'camera'));
    } else if (originFilter === 'link') {
      list = list.filter(d => d.origem === 'link' || (!d.temArquivoLocal && d.origem !== 'camera'));
    }
  }

  const container = document.getElementById('documentsGridContainer');
  if (container) {
    if (list.length === 0) {
      container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">Nenhum arquivo ou foto encontrado com os filtros selecionados.</div>';
    } else {
      container.innerHTML = list.map(doc => createDocumentCardHtml(doc)).join('');
    }
  }

  // Atualizar contadores das métricas
  updateRepoMetrics();
}

async function updateRepoMetrics() {
  const totalEl = document.getElementById('repoMetricTotal');
  const fotosEl = document.getElementById('repoMetricFotos');
  const laudosEl = document.getElementById('repoMetricLaudos');
  const storageEl = document.getElementById('repoMetricStorage');

  if (!totalEl) return;

  const total = appData.documentos.length;
  const fotos = appData.documentos.filter(d => d.tipo === 'Fotos' || d.origem === 'camera').length;
  const laudos = appData.documentos.filter(d => d.tipo === 'CRLV' || d.tipo === 'ATPV' || (d.tipo && d.tipo.toLowerCase().includes('laudo'))).length;
  const totalBytes = await AppFileRepo.calcularTotalBytes();

  totalEl.textContent = total;
  if (fotosEl) fotosEl.textContent = fotos;
  if (laudosEl) laudosEl.textContent = laudos;
  if (storageEl) storageEl.textContent = formatBytes(totalBytes);
}

function createDocumentCardHtml(doc) {
  const car = appData.veiculos.find(v => Number(v.id) === Number(doc.veiculoId));
  const carDesc = car ? `${car.marca} ${car.modelo}` : (doc.modelo || 'Veículo');
  const carPlate = car ? car.placa : (doc.placa || '');

  const isCamera = doc.origem === 'camera';
  const isUpload = doc.origem === 'upload' || (doc.temArquivoLocal && !isCamera);
  const isLink = doc.origem === 'link' || (!doc.temArquivoLocal && !isCamera);

  let originBadge = '';
  if (isCamera) {
    originBadge = `<span class="repo-item-badge-origin">📸 Foto Câmera</span>`;
  } else if (isUpload) {
    originBadge = `<span class="repo-item-badge-origin">📁 Repositório</span>`;
  } else {
    originBadge = `<span class="repo-item-badge-origin" style="background: rgba(30, 41, 59, 0.9);">🔗 Link Externo</span>`;
  }

  const isImage = (doc.tipoMime && doc.tipoMime.startsWith('image/')) || doc.tipo === 'Fotos' || (doc.nomeArquivo && doc.nomeArquivo.match(/\.(jpg|jpeg|png|webp|gif)$/i));
  const isPdf = (doc.tipoMime && doc.tipoMime.includes('pdf')) || doc.tipo === 'CRLV' || doc.tipo === 'ATPV' || (doc.link && doc.link.toLowerCase().endsWith('.pdf'));

  let thumbHtml = '';
  if (isImage) {
    thumbHtml = `
      <div class="repo-item-thumb-wrapper" onclick="previewDocumentFile(${doc.id})">
        ${originBadge}
        <span class="status-pill upcoming repo-item-badge-type">${doc.tipo}</span>
        <img src="" id="docThumbImg_${doc.id}" class="repo-item-thumb-img" alt="${doc.tipo}" style="display: none;">
        <div id="docThumbPlaceholder_${doc.id}" class="repo-item-thumb-placeholder">
          <span style="font-size: 2.2rem;">🖼️</span>
          <span style="font-size: 0.76rem; font-weight: 600;">Abrir Foto</span>
        </div>
      </div>
    `;
    loadThumbAsync(doc);
  } else if (isPdf) {
    thumbHtml = `
      <div class="repo-item-thumb-wrapper" onclick="previewDocumentFile(${doc.id})" style="background: linear-gradient(135deg, rgba(239, 68, 68, 0.15) 0%, rgba(220, 38, 38, 0.05) 100%);">
        ${originBadge}
        <span class="status-pill upcoming repo-item-badge-type">${doc.tipo}</span>
        <div class="repo-item-thumb-placeholder" style="color: var(--danger);">
          <span style="font-size: 2.4rem;">📕</span>
          <span style="font-size: 0.82rem; font-weight: 600; color: var(--text-main);">${doc.tipo}</span>
        </div>
      </div>
    `;
  } else {
    thumbHtml = `
      <div class="repo-item-thumb-wrapper" onclick="previewDocumentFile(${doc.id})">
        ${originBadge}
        <span class="status-pill upcoming repo-item-badge-type">${doc.tipo}</span>
        <div class="repo-item-thumb-placeholder">
          <span style="font-size: 2.2rem;">📄</span>
          <span style="font-size: 0.8rem; font-weight: 600;">${doc.tipo}</span>
        </div>
      </div>
    `;
  }

  return `
    <div class="repo-item-card" id="docCard_${doc.id}">
      ${thumbHtml}
      <div class="repo-item-body">
        <div>
          <h3 class="repo-item-title">${doc.nomeArquivo || doc.tipo}</h3>
          <span class="repo-item-car-info">${carDesc} • <strong style="font-family: monospace;">${carPlate}</strong></span>
        </div>

        ${doc.observacao ? `<p style="font-size: 0.78rem; color: var(--text-dim); line-height: 1.4;">${doc.observacao}</p>` : ''}

        <div class="repo-item-meta">
          <span>📅 ${formatDate(doc.dataUpload)}</span>
          <span>${doc.tamanhoFormatado || (isLink ? 'Nuvem' : 'Local')}</span>
        </div>

        <div class="repo-item-actions">
          <button class="btn btn-primary btn-sm" style="flex: 1;" onclick="previewDocumentFile(${doc.id})" title="Visualizar em Tela Cheia">
            👁️ Ver
          </button>
          <button class="btn btn-secondary btn-sm" onclick="downloadDocumentFile(${doc.id})" title="Baixar / Abrir Arquivo">
            📥
          </button>
          <button class="btn btn-secondary btn-sm" onclick="copyLink('${doc.link || ''}')" title="Copiar Informações">
            📋
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteDocument(${doc.id})" title="Excluir do Repositório">
            ✕
          </button>
        </div>
      </div>
    </div>
  `;
}

async function loadThumbAsync(doc) {
  setTimeout(async () => {
    const imgEl = document.getElementById(`docThumbImg_${doc.id}`);
    const placeholder = document.getElementById(`docThumbPlaceholder_${doc.id}`);
    if (!imgEl) return;

    if (doc.temArquivoLocal) {
      const fileData = await AppFileRepo.obter(doc.id);
      if (fileData && fileData.dataBase64) {
        imgEl.src = fileData.dataBase64;
        imgEl.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
      }
    } else if (doc.link && (doc.link.startsWith('http') || doc.link.startsWith('data:'))) {
      imgEl.src = doc.link;
      imgEl.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
    }
  }, 20);
}

async function previewDocumentFile(docId) {
  const doc = appData.documentos.find(d => Number(d.id) === Number(docId));
  if (!doc) return;

  const car = appData.veiculos.find(v => Number(v.id) === Number(doc.veiculoId));
  const carDesc = car ? `${car.marca} ${car.modelo} (${car.placa})` : 'Veículo';

  const titleEl = document.getElementById('previewModalTitle');
  const subEl = document.getElementById('previewModalSubtitle');
  const metaEl = document.getElementById('previewModalMeta');
  const container = document.getElementById('previewMediaContainer');
  const downloadBtn = document.getElementById('previewDownloadBtn');

  if (titleEl) titleEl.textContent = `${doc.tipo} - ${doc.nomeArquivo || 'Arquivo'}`;
  if (subEl) subEl.textContent = `${carDesc} • Enviado em ${formatDate(doc.dataUpload)}`;
  if (metaEl) metaEl.textContent = `Origem: ${doc.origem === 'camera' ? 'Câmera do Dispositivo' : (doc.origem === 'upload' ? 'Repositório Local' : 'Link Externo')} • Tamanho: ${doc.tamanhoFormatado || '-'}`;

  if (container) container.innerHTML = '<div style="padding: 30px; color: var(--text-dim); text-align: center;">Carregando arquivo...</div>';
  openModal('modalPreviewFile');

  let fileContent = null;
  if (doc.temArquivoLocal) {
    const fileData = await AppFileRepo.obter(doc.id);
    if (fileData && fileData.dataBase64) {
      fileContent = fileData.dataBase64;
    }
  }

  const isImage = (doc.tipoMime && doc.tipoMime.startsWith('image/')) || doc.tipo === 'Fotos' || (doc.nomeArquivo && doc.nomeArquivo.match(/\.(jpg|jpeg|png|webp|gif)$/i));
  const isPdf = (doc.tipoMime && doc.tipoMime.includes('pdf')) || (doc.link && doc.link.toLowerCase().endsWith('.pdf'));

  if (fileContent) {
    if (downloadBtn) {
      downloadBtn.href = fileContent;
      downloadBtn.download = doc.nomeArquivo || `documento_${doc.id}`;
      downloadBtn.style.display = 'inline-flex';
      downloadBtn.textContent = '📥 Baixar Arquivo';
    }

    if (isImage) {
      container.innerHTML = `<img src="${fileContent}" class="lightbox-img-full" alt="${doc.tipo}">`;
    } else if (isPdf) {
      container.innerHTML = `
        <div style="text-align: center; padding: 24px;">
          <div style="font-size: 3.5rem; margin-bottom: 12px;">📕</div>
          <h4 style="font-size: 1.15rem; margin-bottom: 8px;">${doc.nomeArquivo || 'Documento PDF'}</h4>
          <p style="color: var(--text-muted); font-size: 0.85rem; max-width: 420px; margin: 0 auto 16px;">
            Este documento PDF está armazenado com segurança no repositório interno da aplicação.
          </p>
          <a href="${fileContent}" download="${doc.nomeArquivo || 'documento.pdf'}" class="btn btn-primary">
            📥 Baixar / Abrir PDF Completo
          </a>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div style="text-align: center; padding: 24px;">
          <div style="font-size: 3.5rem; margin-bottom: 12px;">📄</div>
          <h4 style="font-size: 1.15rem; margin-bottom: 8px;">${doc.nomeArquivo || 'Arquivo'}</h4>
          <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 16px;">${doc.observacao || 'Arquivo salvo no repositório.'}</p>
          <a href="${fileContent}" download="${doc.nomeArquivo || 'arquivo'}" class="btn btn-primary">
            📥 Baixar Arquivo
          </a>
        </div>
      `;
    }
  } else {
    // É link externo (Google Drive, OneDrive, etc.)
    const isUrl = doc.link && (doc.link.startsWith('http://') || doc.link.startsWith('https://'));
    if (isUrl) {
      if (downloadBtn) {
        downloadBtn.href = doc.link;
        downloadBtn.target = '_blank';
        downloadBtn.download = '';
        downloadBtn.style.display = 'inline-flex';
        downloadBtn.textContent = 'Abrir no Google Drive ↗';
      }

      container.innerHTML = `
        <div style="text-align: center; padding: 24px;">
          <div style="font-size: 3.5rem; margin-bottom: 12px;">☁️</div>
          <h4 style="font-size: 1.15rem; margin-bottom: 8px;">${doc.tipo} (Link Externo)</h4>
          <p style="color: var(--text-muted); font-size: 0.85rem; max-width: 480px; margin: 0 auto 16px;">
            Este documento está hospedado na nuvem (Google Drive / OneDrive):<br>
            <a href="${doc.link}" target="_blank" style="color: var(--primary); word-break: break-all;">${doc.link}</a>
          </p>
          <a href="${doc.link}" target="_blank" class="btn btn-primary">
            Abrir Link Externo ↗
          </a>
        </div>
      `;
    } else {
      if (downloadBtn) downloadBtn.style.display = 'none';
      container.innerHTML = `
        <div style="text-align: center; padding: 24px;">
          <div style="font-size: 3.5rem; margin-bottom: 12px;">📁</div>
          <h4 style="font-size: 1.15rem;">${doc.tipo} - ${doc.link || doc.nomeArquivo}</h4>
          <p style="color: var(--text-muted); font-size: 0.85rem;">${doc.observacao || 'Documento registrado no sistema.'}</p>
        </div>
      `;
    }
  }
}

async function downloadDocumentFile(docId) {
  const doc = appData.documentos.find(d => Number(d.id) === Number(docId));
  if (!doc) return;

  if (doc.temArquivoLocal) {
    const fileData = await AppFileRepo.obter(doc.id);
    if (fileData && fileData.dataBase64) {
      const a = document.createElement('a');
      a.href = fileData.dataBase64;
      a.download = doc.nomeArquivo || `documento_${doc.id}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`Download de "${doc.nomeArquivo}" iniciado!`);
      return;
    }
  }

  if (doc.link && (doc.link.startsWith('http://') || doc.link.startsWith('https://'))) {
    window.open(doc.link, '_blank');
  } else {
    previewDocumentFile(docId);
  }
}

async function deleteDocument(docId) {
  if (!requireFullAccess()) return;
  if (confirm('Deseja realmente remover este arquivo do repositório?')) {
    await AppFileRepo.excluir(docId);
    appData.documentos = appData.documentos.filter(d => Number(d.id) !== Number(docId));
    saveDatabase();
    renderDocumentsGrid();
    if (currentDetailCarId) renderVehicleDetail(currentDetailCarId);
    showToast('Arquivo removido do repositório.');
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
    const atrasadas = pendentes.filter(isInstallmentOverdue).length;
    const situacao = isQuitado
      ? '<span class="status-pill pago">QUITADO</span>'
      : (atrasadas > 0
        ? `<span class="status-pill atrasado">${atrasadas} em atraso</span>`
        : '<span class="status-pill upcoming">Em dia</span>');

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
        <td>${situacao}</td>
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
// Modais que o perfil de visualização pode abrir (não alteram dados)
const READ_ONLY_MODALS = ['modalCarnetPix', 'modalChangePassword'];

function openModal(modalId) {
  if (!READ_ONLY_MODALS.includes(modalId) && !requireFullAccess()) return;
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
  if (!m || m.dataset.locked === '1') return;
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
  document.getElementById('vehRenavam').value = '';
  document.getElementById('vehChassi').value = '';
  document.getElementById('vehObservacoes').value = '';
  const statusSel = document.getElementById('vehStatus');
  if (statusSel) { statusSel.value = 'Em estoque'; statusSel.disabled = false; }
  document.getElementById('vehDataCompra').value = new Date().toISOString().slice(0, 10);
  populateVehicleSocioSelect();
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
  document.getElementById('vehRenavam').value = car.renavam || '';
  document.getElementById('vehChassi').value = car.chassi || car.chassis || '';
  document.getElementById('vehObservacoes').value = car.observacoes || '';
  document.getElementById('vehCor').value = car.cor || '';
  document.getElementById('vehKm').value = car.km || '';
  document.getElementById('vehCombustivel').value = car.combustivel || 'Flex';
  document.getElementById('vehCambio').value = car.cambio || 'Manual';
  populateVehicleSocioSelect(car);
  document.getElementById('vehAntigoDono').value = car.antigoDono || '';
  document.getElementById('vehDataCompra').value = car.dataCompra || '';
  document.getElementById('vehValorCompra').value = car.valorCompra || '';
  document.getElementById('vehValorFipe').value = car.valorFipe || '';

  // Preencher status e desabilitar se vendido
  const statusSel = document.getElementById('vehStatus');
  if (statusSel) {
    if (car.status === 'Vendido') {
      statusSel.value = 'Em estoque';
      statusSel.disabled = true;
    } else {
      statusSel.value = car.status || 'Em estoque';
      statusSel.disabled = false;
    }
  }

  // Mostrar alerta de reverter venda apenas se o veículo está vendido
  const revertBlock = document.getElementById('revertSaleBlock');
  if (revertBlock) {
    revertBlock.style.display = car.status === 'Vendido' ? 'block' : 'none';
    revertBlock.dataset.carId = car.id;
  }

  openModal('modalVehicle');
}

function editCurrentCar() {
  if (currentDetailCarId) editCarById(currentDetailCarId);
}

function handleSaveVehicle(e) {
  e.preventDefault();
  const idVal = document.getElementById('vehId').value;
  const isEdit = Boolean(idVal);

  const socioValue = document.getElementById('vehSocio').value;
  const carroAtual = isEdit ? appData.veiculos.find(v => Number(v.id) === Number(idVal)) : null;
  const socioId = Number(socioValue) || null;
  let sociedade = '';
  if (socioId) {
    const socio = availableSocios.find(s => Number(s.id) === socioId);
    sociedade = socio ? socio.nome : (carroAtual && carroAtual.sociedade) || '';
  } else if (socioValue === 'legado' && carroAtual) {
    sociedade = carroAtual.sociedade || '';
  }

  const vehicleObj = {
    id: isEdit ? Number(idVal) : (Math.max(0, ...appData.veiculos.map(v => Number(v.id) || 0)) + 1),
    marca: document.getElementById('vehMarca').value.trim(),
    modelo: document.getElementById('vehModelo').value.trim(),
    ano: Number(document.getElementById('vehAno').value),
    placa: document.getElementById('vehPlaca').value.trim().toUpperCase(),
    renavam: document.getElementById('vehRenavam').value.trim(),
    chassi: document.getElementById('vehChassi').value.trim().toUpperCase(),
    observacoes: document.getElementById('vehObservacoes').value.trim(),
    cor: document.getElementById('vehCor').value.trim(),
    km: Number(document.getElementById('vehKm').value) || 0,
    combustivel: document.getElementById('vehCombustivel').value,
    cambio: document.getElementById('vehCambio').value,
    socioId,
    sociedade,
    antigoDono: document.getElementById('vehAntigoDono').value.trim(),
    dataCompra: document.getElementById('vehDataCompra').value,
    valorCompra: Number(document.getElementById('vehValorCompra').value) || 0,
    valorFipe: Number(document.getElementById('vehValorFipe').value) || 0,
    status: isEdit
      ? (appData.veiculos.find(v => Number(v.id) === Number(idVal)).status === 'Vendido'
        ? 'Vendido'
        : (document.getElementById('vehStatus').value || 'Em estoque'))
      : (document.getElementById('vehStatus').value || 'Em estoque')
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

// ============================================================================
// REVERTER VENDA
// ============================================================================
function revertSale() {
  if (!requireFullAccess()) return;
  // Tenta pegar o ID a partir do bloco no modal (se chamado de lá) ou da ficha atual
  const revertBlock = document.getElementById('revertSaleBlock');
  const idFromModal = revertBlock && revertBlock.dataset.carId ? Number(revertBlock.dataset.carId) : null;
  const targetId = idFromModal || currentDetailCarId;

  if (!targetId) {
    showToast('Nenhum veículo selecionado para reverter.');
    return;
  }

  const car = appData.veiculos.find(v => Number(v.id) === Number(targetId));
  if (!car) return;

  if (car.status !== 'Vendido') {
    showToast('Este veículo não está marcado como vendido.');
    return;
  }

  const compradorNome = car.comprador || 'comprador';
  const numParc = car.numParcelas || 0;
  const confirmMsg = `Reverter a venda do ${car.marca} ${car.modelo} (${car.placa})?\n\nIsso irá:\n• Remover os dados de ${compradorNome}\n• Apagar o carnê de ${numParc} parcela(s)\n• Voltar o status para "Em estoque"\n\nEsta ação não pode ser desfeita.`;

  if (!confirm(confirmMsg)) return;

  // Remover parcelas vinculadas ao veículo
  const parcelasRemovidas = appData.pagamentos.filter(p => Number(p.veiculoId) === Number(car.id)).length;
  appData.pagamentos = appData.pagamentos.filter(p => Number(p.veiculoId) !== Number(car.id));

  // Zerar todos os campos de venda
  car.status = 'Em estoque';
  car.dataVenda = '';
  car.comprador = '';
  car.telefoneComprador = '';
  car.valorVenda = 0;
  car.parcelamento = '';
  car.valorEntrada = 0;
  car.numParcelas = 0;
  car.valorParcela = 0;
  car.lucro = 0;

  saveDatabase();
  updateCalculations();
  closeModal('modalVehicle');
  renderDashboard();
  renderInventory();
  renderPaymentsMatrix();
  renderActiveFinancings();
  if (currentDetailCarId && Number(currentDetailCarId) === Number(car.id)) {
    renderVehicleDetail(car.id);
  }

  showToast(`Venda revertida! ${car.marca} ${car.modelo} voltou ao estoque. ${parcelasRemovidas} parcela(s) removida(s).`);
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

// ============================================================================
// MODAL REPOSITÓRIO: ANEXAR ARQUIVO & TIRAR FOTOS
// ============================================================================
function openModalAddDocument(initialTab = 'upload') {
  const form = document.getElementById('formDocument');
  if (form) form.reset();
  clearSelectedUploadFile();

  const dateInput = document.getElementById('docData');
  if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);

  switchDocTab(initialTab);
  openModal('modalDocument');
}

function openModalAddDocumentForCurrentCar(initialTab = 'upload') {
  openModalAddDocument(initialTab);
  if (currentDetailCarId) {
    const sel = document.getElementById('docCarSelect');
    if (sel) sel.value = currentDetailCarId;
  }
}

function closeModalDocument() {
  stopCamera();
  closeModal('modalDocument');
}

function switchDocTab(tabName) {
  const tabUpload = document.getElementById('tabBtnDocUpload');
  const tabCamera = document.getElementById('tabBtnDocCamera');
  const tabLink = document.getElementById('tabBtnDocLink');

  if (tabUpload) tabUpload.classList.toggle('active', tabName === 'upload');
  if (tabCamera) tabCamera.classList.toggle('active', tabName === 'camera');
  if (tabLink) tabLink.classList.toggle('active', tabName === 'link');

  const panelUpload = document.getElementById('panelDocUpload');
  const panelCamera = document.getElementById('panelDocCamera');
  const panelLink = document.getElementById('panelDocLink');

  if (panelUpload) panelUpload.style.display = tabName === 'upload' ? 'block' : 'none';
  if (panelCamera) panelCamera.style.display = tabName === 'camera' ? 'block' : 'none';
  if (panelLink) panelLink.style.display = tabName === 'link' ? 'block' : 'none';

  const originInput = document.getElementById('docOrigin');
  if (originInput) originInput.value = tabName;

  if (tabName === 'camera') {
    startCamera(currentCameraFacing);
  } else {
    stopCamera();
  }
}

// Câmera ao vivo
async function startCamera(facing = 'environment') {
  stopCamera();
  const video = document.getElementById('cameraVideo');
  if (!video) return;

  currentCameraFacing = facing;
  const constraints = {
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  };

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = cameraStream;
    await video.play();

    const liveSec = document.getElementById('cameraLiveSection');
    const prevSec = document.getElementById('cameraCapturedPreviewBox');
    if (liveSec) liveSec.style.display = 'block';
    if (prevSec) prevSec.style.display = 'none';
  } catch (err) {
    console.warn('Câmera indisponível ou permissão negada:', err);
    // Em caso de erro na webcam (ex: desktop sem webcam), exibe alerta amigável
    const liveSec = document.getElementById('cameraLiveSection');
    if (liveSec) {
      liveSec.innerHTML = `
        <div style="background: var(--bg-card); padding: 24px; text-align: center; border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
          <div style="font-size: 2.2rem; margin-bottom: 8px;">📷</div>
          <p style="font-size: 0.88rem; color: var(--text-muted); margin-bottom: 12px;">
            Não foi possível abrir o streaming de vídeo da câmera neste navegador/dispositivo.
          </p>
          <label class="btn btn-primary btn-sm" style="cursor: pointer;">
            <input type="file" accept="image/*" capture="environment" style="display: none;" onchange="handleNativeCameraCapture(event)">
            📸 Abrir Câmera do Celular ou Arquivo de Foto
          </label>
        </div>
      `;
    }
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  const video = document.getElementById('cameraVideo');
  if (video) video.srcObject = null;
}

function switchCameraFacing() {
  const nextFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
  startCamera(nextFacing);
}

function capturePhotoFromCamera() {
  const video = document.getElementById('cameraVideo');
  if (!video || !cameraStream) {
    alert('A câmera precisa estar ativa para capturar a foto.');
    return;
  }

  const canvas = document.createElement('canvas');
  let w = video.videoWidth || 1280;
  let h = video.videoHeight || 720;
  // Limita a largura máxima para economizar armazenamento mantendo ótima nitidez
  if (w > 1280) {
    h = Math.round((h * 1280) / w);
    w = 1280;
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const sizeBytes = Math.round(dataUrl.length * 0.75);

  stopCamera();

  const liveSec = document.getElementById('cameraLiveSection');
  const prevSec = document.getElementById('cameraCapturedPreviewBox');
  const imgEl = document.getElementById('cameraCapturedImg');

  if (liveSec) liveSec.style.display = 'none';
  if (prevSec) prevSec.style.display = 'block';
  if (imgEl) imgEl.src = dataUrl;

  document.getElementById('docFileBase64').value = dataUrl;
  document.getElementById('docFileName').value = `Foto_${new Date().toISOString().slice(0, 10)}_${Date.now().toString().slice(-4)}.jpg`;
  document.getElementById('docFileSize').value = sizeBytes;
  document.getElementById('docFileType').value = 'image/jpeg';
  document.getElementById('docOrigin').value = 'camera';

  const selTipo = document.getElementById('docTipo');
  if (selTipo) selTipo.value = 'Fotos';

  showToast('Foto capturada com sucesso!');
}

function retakeCameraPhoto() {
  document.getElementById('docFileBase64').value = '';
  document.getElementById('docFileName').value = '';
  document.getElementById('docFileSize').value = '0';
  document.getElementById('docFileType').value = '';

  const liveSec = document.getElementById('cameraLiveSection');
  const prevSec = document.getElementById('cameraCapturedPreviewBox');
  if (liveSec) liveSec.style.display = 'block';
  if (prevSec) prevSec.style.display = 'none';

  startCamera(currentCameraFacing);
}

function handleNativeCameraCapture(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    stopCamera();

    const liveSec = document.getElementById('cameraLiveSection');
    const prevSec = document.getElementById('cameraCapturedPreviewBox');
    const imgEl = document.getElementById('cameraCapturedImg');

    if (liveSec) liveSec.style.display = 'none';
    if (prevSec) prevSec.style.display = 'block';
    if (imgEl) imgEl.src = dataUrl;

    document.getElementById('docFileBase64').value = dataUrl;
    document.getElementById('docFileName').value = file.name || `Foto_${Date.now()}.jpg`;
    document.getElementById('docFileSize').value = file.size;
    document.getElementById('docFileType').value = file.type || 'image/jpeg';
    document.getElementById('docOrigin').value = 'camera';

    const selTipo = document.getElementById('docTipo');
    if (selTipo) selTipo.value = 'Fotos';

    showToast('Foto capturada do dispositivo!');
  };
  reader.readAsDataURL(file);
}

// Drag & Drop e Seleção de Arquivos
function setupRepoDropzoneEvents() {
  const dropzone = document.getElementById('docDropzone');
  if (!dropzone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
      processSelectedFile(files[0]);
    }
  });
}

function handleDocFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  processSelectedFile(file);
}

function processSelectedFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;

    document.getElementById('docFileBase64').value = dataUrl;
    document.getElementById('docFileName').value = file.name;
    document.getElementById('docFileSize').value = file.size;
    document.getElementById('docFileType').value = file.type || 'application/octet-stream';
    document.getElementById('docOrigin').value = 'upload';

    const previewCard = document.getElementById('docUploadPreviewCard');
    const nameEl = document.getElementById('docUploadName');
    const metaEl = document.getElementById('docUploadMeta');
    const thumbEl = document.getElementById('docUploadThumb');
    const dropzone = document.getElementById('docDropzone');

    if (nameEl) nameEl.textContent = file.name;
    if (metaEl) metaEl.textContent = `${(file.type.split('/')[1] || 'ARQUIVO').toUpperCase()} • ${formatBytes(file.size)}`;

    if (thumbEl) {
      if (file.type.startsWith('image/')) {
        thumbEl.innerHTML = `<img src="${dataUrl}" style="width:100%; height:100%; object-fit:cover; border-radius:var(--radius-sm);">`;
        const selTipo = document.getElementById('docTipo');
        if (selTipo && selTipo.value === 'CRLV') selTipo.value = 'Fotos';
      } else if (file.type.includes('pdf')) {
        thumbEl.innerHTML = `<span style="font-size:1.6rem;">📕</span>`;
      } else {
        thumbEl.innerHTML = `<span style="font-size:1.6rem;">📄</span>`;
      }
    }

    if (previewCard) previewCard.style.display = 'flex';
    if (dropzone) dropzone.style.display = 'none';

    showToast(`Arquivo "${file.name}" pronto para anexar!`);
  };
  reader.readAsDataURL(file);
}

function clearSelectedUploadFile() {
  const fileInput = document.getElementById('docFileInput');
  if (fileInput) fileInput.value = '';

  document.getElementById('docFileBase64').value = '';
  document.getElementById('docFileName').value = '';
  document.getElementById('docFileSize').value = '0';
  document.getElementById('docFileType').value = '';

  const previewCard = document.getElementById('docUploadPreviewCard');
  const dropzone = document.getElementById('docDropzone');
  if (previewCard) previewCard.style.display = 'none';
  if (dropzone) dropzone.style.display = 'block';
}

// Salvar Documento / Foto no Repositório
async function handleSaveDocument(e) {
  e.preventDefault();
  const carId = Number(document.getElementById('docCarSelect').value);
  const car = appData.veiculos.find(v => Number(v.id) === carId);
  if (!car) {
    alert('Selecione um veículo válido.');
    return;
  }

  const origin = document.getElementById('docOrigin').value;
  const fileBase64 = document.getElementById('docFileBase64').value;
  const fileName = document.getElementById('docFileName').value;
  const fileSize = Number(document.getElementById('docFileSize').value) || 0;
  const fileType = document.getElementById('docFileType').value;
  const linkExterno = document.getElementById('docLink').value.trim();

  if (origin !== 'link' && !fileBase64) {
    alert('Por favor, selecione um arquivo ou tire uma foto antes de salvar.');
    return;
  }
  if (origin === 'link' && !linkExterno) {
    alert('Por favor, informe o link do arquivo.');
    return;
  }

  const docId = Date.now();
  const docObj = {
    id: docId,
    veiculoId: carId,
    placa: car.placa,
    modelo: car.modelo,
    tipo: document.getElementById('docTipo').value,
    link: origin === 'link' ? linkExterno : (fileName || 'Arquivo no Repositório'),
    origem: origin, // 'upload', 'camera', 'link'
    nomeArquivo: fileName || (origin === 'link' ? 'Link na Nuvem' : 'Arquivo'),
    tamanhoBytes: fileSize,
    tamanhoFormatado: formatBytes(fileSize),
    tipoMime: fileType || (origin === 'link' ? 'link/url' : 'application/octet-stream'),
    dataUpload: document.getElementById('docData').value,
    observacao: document.getElementById('docObs').value.trim(),
    temArquivoLocal: origin !== 'link'
  };

  // Envia o arquivo ao servidor caso seja upload ou foto da câmera
  if (origin !== 'link' && fileBase64) {
    const enviado = await AppFileRepo.salvar(docId, {
      id: docId,
      veiculoId: carId,
      nome: fileName,
      tipoMime: fileType,
      tamanhoBytes: fileSize,
      dataBase64: fileBase64,
      criadoEm: new Date().toISOString()
    });
    if (!enviado) return;
  }

  appData.documentos.push(docObj);
  saveDatabase();
  closeModalDocument();
  renderDocumentsGrid();
  if (currentDetailCarId && currentDetailCarId === carId) {
    renderVehicleDetail(carId);
  }

  showToast(`Salvo no Repositório com sucesso!`);
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
    // Garante que todas as parcelas estejam geradas antes de filtrar
    appData.veiculos.forEach(v => {
      if (v.status === 'Vendido' && (v.numParcelas > 0 || v.parcelamento === 'Parcelado')) {
        ensureInstallmentsForCar(v);
      }
    });

    const soldFinanced = appData.veiculos.filter(v =>
      v.status === 'Vendido' && (v.numParcelas > 0 || v.parcelamento === 'Parcelado')
    );
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

  const soldFinanced = appData.veiculos.filter(v =>
    v.status === 'Vendido' && (v.numParcelas > 0 || v.parcelamento === 'Parcelado')
  );
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
    if (valHint) valHint.textContent = 'O valor informado será abatido das últimas parcelas para as primeiras (ordem decrescente).';
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
    // Simula o abatimento a partir da última parcela para mostrar quais serão afetadas
    let restanteSim = valPago;
    const quitadasSim = [];
    let parcialSim = null;
    for (let i = pendentes.length - 1; i >= 0 && restanteSim > 0; i--) {
      const p = pendentes[i];
      if (restanteSim >= Number(p.valor)) {
        quitadasSim.push(p.numeroParcela);
        restanteSim -= Number(p.valor);
      } else {
        parcialSim = p.numeroParcela;
        restanteSim = 0;
      }
    }
    descricaoAcao = `Amortização de ${formatMoney(valPago)} abatendo das últimas parcelas para as primeiras` +
      (quitadasSim.length ? ` • Quitadas: Nº ${quitadasSim.join(', ')}` : '') +
      (parcialSim !== null ? ` • Abatimento parcial na Nº ${parcialSim}` : '') + '.';
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
    // Abate em ordem decrescente: da última parcela em aberto para a primeira
    let restante = valPago;
    let baixadas = 0;
    for (let i = pendentes.length - 1; i >= 0; i--) {
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
  const headers = ['ID', 'Data da compra', 'Marca', 'Modelo', 'Ano', 'Placa', 'Renavam', 'Chassis', 'Cor', 'KM', 'Combustivel', 'Cambio', 'Sociedade', 'Antigo dono', 'Valor de compra', 'Despesas (total)', 'Custo final', 'Valor FIPE', 'Data da venda', 'Novo comprador', 'Valor de venda', 'Parcelamento', 'Valor da entrada', 'Nº de parcelas', 'Valor da parcela', 'Lucro', 'Status', 'Observacoes'];

  const rows = appData.veiculos.map(v => [
    v.id,
    v.dataCompra,
    v.marca,
    `"${v.modelo}"`,
    v.ano,
    v.placa,
    `"${v.renavam || ''}"`,
    `"${v.chassi || v.chassis || ''}"`,
    v.cor || '',
    v.km || '',
    v.combustivel || '',
    v.cambio || '',
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
    v.status,
    `"${(v.observacoes || '').replace(/"/g, '""')}"`
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
  const headers = ['ID', 'ID do veiculo', 'Placa', 'Modelo', 'Tipo de documento', 'Origem', 'Nome do Arquivo', 'Tamanho', 'Link / Local', 'Data de upload', 'Observacao'];

  const rows = appData.documentos.map(doc => {
    const car = appData.veiculos.find(v => Number(v.id) === Number(doc.veiculoId));
    return [
      doc.id,
      doc.veiculoId,
      car ? car.placa : (doc.placa || ''),
      `"${car ? car.modelo : (doc.modelo || '')}"`,
      doc.tipo,
      doc.origem || 'link',
      `"${doc.nomeArquivo || ''}"`,
      doc.tamanhoFormatado || '',
      `"${doc.link || ''}"`,
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
  event.target.value = '';
  if (!file || !requireFullAccess()) return;
  if (!confirm('Restaurar este backup substituirá TODOS os dados do servidor para todos os usuários. Deseja continuar?')) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported.veiculos && Array.isArray(imported.veiculos)) {
        appData = {
          veiculos: imported.veiculos,
          despesas: imported.despesas || [],
          documentos: imported.documentos || [],
          pagamentos: imported.pagamentos || []
        };
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

function printSingleCarCarnet(carId) {
  openModalCarnetPix(carId);
}

// ============================================================================
// MODAL 7: CARNÊ COM QR CODE PIX (padrão BR Code / EMV do Banco Central)
// ============================================================================
const PIX_CONFIG_STORAGE_KEY = 'automanage_toledo_pix';

const PIX_KEY_PLACEHOLDERS = {
  cpf: '000.000.000-00',
  cnpj: '00.000.000/0000-00',
  celular: '(11) 98765-4321',
  email: 'financeiro@empresa.com.br',
  aleatoria: '123e4567-e89b-12d3-a456-426614174000'
};

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function loadPixConfig() {
  try {
    return JSON.parse(localStorage.getItem(PIX_CONFIG_STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function savePixConfig(config) {
  try {
    localStorage.setItem(PIX_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch (e) {
    console.warn('Não foi possível salvar os dados do PIX:', e);
  }
}

function getFinancedCars() {
  return appData.veiculos.filter(v => v.status === 'Vendido' && (v.numParcelas > 0));
}

function openModalCarnetPix(carId = null) {
  const financed = getFinancedCars();
  if (financed.length === 0) {
    showToast('Não há veículos com financiamento ou parcelamento cadastrados.');
    return;
  }

  let targetId = Number(carId) || Number(currentDetailCarId);
  if (!targetId || !financed.some(v => Number(v.id) === targetId)) {
    targetId = financed[0].id;
  }

  const sel = document.getElementById('carnetVehSelect');
  sel.innerHTML = financed.map(v => `
    <option value="${v.id}" ${Number(v.id) === targetId ? 'selected' : ''}>
      ${escapeHtml(`${v.marca} ${v.modelo} (${v.placa}) — ${v.comprador || 'Comprador não informado'}`)}
    </option>
  `).join('');

  // Recupera os dados do recebedor usados na última geração
  const config = loadPixConfig();
  document.getElementById('carnetPixTipo').value = config.tipo || 'cpf';
  document.getElementById('carnetPixChave').value = config.chave || '';
  document.getElementById('carnetPixNome').value = config.nome || '';
  document.getElementById('carnetPixCidade').value = config.cidade || '';
  document.getElementById('carnetParcelasFiltro').value = 'pendentes';

  updateCarnetPixKeyPlaceholder();
  updateCarnetPixSummary();
  openModal('modalCarnetPix');
}

function updateCarnetPixKeyPlaceholder() {
  const tipo = document.getElementById('carnetPixTipo').value;
  document.getElementById('carnetPixChave').placeholder = PIX_KEY_PLACEHOLDERS[tipo] || '';
}

function getCarnetInstallments(car, filtro) {
  ensureInstallmentsForCar(car);
  return appData.pagamentos
    .filter(p => Number(p.veiculoId) === Number(car.id) && (filtro === 'todas' || p.status !== 'pago'))
    .sort((a, b) => Number(a.numeroParcela) - Number(b.numeroParcela));
}

function updateCarnetPixSummary() {
  const carId = Number(document.getElementById('carnetVehSelect').value);
  const car = appData.veiculos.find(v => Number(v.id) === carId);
  const box = document.getElementById('carnetSummary');
  const btn = document.getElementById('btnGenerateCarnet');
  if (!car) {
    box.textContent = 'Selecione um veículo.';
    btn.disabled = true;
    return;
  }

  const filtro = document.getElementById('carnetParcelasFiltro').value;
  const parcelas = getCarnetInstallments(car, filtro);
  const pendentes = parcelas.filter(p => p.status !== 'pago');
  const total = pendentes.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);

  box.innerHTML = parcelas.length === 0
    ? '<strong style="color: var(--success);">✅ Este veículo não possui parcelas em aberto.</strong> Escolha "Todas as parcelas" para imprimir o histórico.'
    : `<strong>${parcelas.length} parcela(s) no carnê</strong> • ${pendentes.length} com QR Code PIX • Total em aberto: <strong style="color: var(--warning);">${formatMoney(total)}</strong>`;
  btn.disabled = parcelas.length === 0;
}

// Remove acentos e caracteres fora do padrão aceito pelo BR Code
function sanitizePixText(text, maxLength) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,\-/]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizePixKey(tipo, rawKey) {
  const key = String(rawKey || '').trim();
  const digits = key.replace(/\D/g, '');

  if (tipo === 'cpf') {
    return digits.length === 11 ? { key: digits } : { error: 'O CPF deve ter 11 dígitos.' };
  }
  if (tipo === 'cnpj') {
    return digits.length === 14 ? { key: digits } : { error: 'O CNPJ deve ter 14 dígitos.' };
  }
  if (tipo === 'celular') {
    if (digits.length === 10 || digits.length === 11) return { key: `+55${digits}` };
    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return { key: `+${digits}` };
    return { error: 'Informe o celular com DDD. Ex: (11) 98765-4321.' };
  }
  if (tipo === 'email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key) ? { key: key.toLowerCase() } : { error: 'E-mail inválido.' };
  }
  // Chave aleatória (EVP): UUID de 36 caracteres
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
    ? { key: key.toLowerCase() }
    : { error: 'Chave aleatória inválida. Ela tem o formato 123e4567-e89b-12d3-a456-426614174000.' };
}

function pixField(id, value) {
  const str = String(value);
  return `${id}${String(str.length).padStart(2, '0')}${str}`;
}

// CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF), exigido no campo 63 do BR Code
function pixCRC16(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildPixPayload({ chave, nome, cidade, valor, txid, descricao }) {
  let merchantAccount = pixField('00', 'br.gov.bcb.pix') + pixField('01', chave);
  // A descrição é opcional; só entra se couber no limite de 99 caracteres do campo 26
  if (descricao) {
    const withDesc = merchantAccount + pixField('02', descricao);
    if (withDesc.length <= 99) merchantAccount = withDesc;
  }

  const payload =
    pixField('00', '01') +
    pixField('26', merchantAccount) +
    pixField('52', '0000') +
    pixField('53', '986') +
    (valor > 0 ? pixField('54', Number(valor).toFixed(2)) : '') +
    pixField('58', 'BR') +
    pixField('59', nome) +
    pixField('60', cidade) +
    pixField('62', pixField('05', txid || '***')) +
    '6304';

  return payload + pixCRC16(payload);
}

function buildPixQrSvg(payload) {
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function handleGenerateCarnetPix(e) {
  e.preventDefault();

  if (typeof qrcode !== 'function') {
    alert('Não foi possível carregar o gerador de QR Code. Verifique a conexão com a internet e recarregue a página.');
    return;
  }

  const carId = Number(document.getElementById('carnetVehSelect').value);
  const car = appData.veiculos.find(v => Number(v.id) === carId);
  if (!car) {
    showToast('Selecione um veículo válido.');
    return;
  }

  const tipo = document.getElementById('carnetPixTipo').value;
  const chaveDigitada = document.getElementById('carnetPixChave').value;
  const nomeDigitado = document.getElementById('carnetPixNome').value;
  const cidadeDigitada = document.getElementById('carnetPixCidade').value;

  const { key, error } = normalizePixKey(tipo, chaveDigitada);
  if (error) {
    alert(error);
    return;
  }

  const nome = sanitizePixText(nomeDigitado, 25).toUpperCase();
  const cidade = sanitizePixText(cidadeDigitada, 15).toUpperCase();
  if (!nome || !cidade) {
    alert('Informe o nome e a cidade do recebedor (sem caracteres especiais).');
    return;
  }

  const filtro = document.getElementById('carnetParcelasFiltro').value;
  const parcelas = getCarnetInstallments(car, filtro);
  if (parcelas.length === 0) {
    showToast('Não há parcelas para gerar o carnê.');
    return;
  }

  // A janela precisa ser aberta ainda dentro do clique para não ser bloqueada como pop-up
  const win = window.open('', '_blank');
  if (!win) {
    alert('O navegador bloqueou a janela do carnê. Permita pop-ups para este site e tente novamente.');
    return;
  }

  savePixConfig({ tipo, chave: chaveDigitada.trim(), nome: nomeDigitado.trim(), cidade: cidadeDigitada.trim() });

  const placaId = sanitizePixText(car.placa, 10).replace(/[^A-Za-z0-9]/g, '').toUpperCase() || `V${car.id}`;
  const slips = parcelas.map(p => {
    const numero = String(p.numeroParcela).padStart(2, '0');
    const isPago = p.status === 'pago';
    const payload = isPago ? '' : buildPixPayload({
      chave: key,
      nome,
      cidade,
      valor: Number(p.valor) || 0,
      txid: `${placaId}P${numero}`.slice(0, 25),
      descricao: sanitizePixText(`Parcela ${p.numeroParcela}/${car.numParcelas} ${car.placa}`, 40)
    });
    return buildCarnetSlipHtml(car, p, { isPago, payload, chaveExibicao: chaveDigitada.trim(), nomeRecebedor: nomeDigitado.trim() });
  }).join('');

  win.document.open();
  win.document.write(buildCarnetDocumentHtml(car, slips));
  win.document.close();

  closeModal('modalCarnetPix');
  showToast(`Carnê gerado com ${parcelas.length} parcela(s).`);
}

function buildCarnetSlipHtml(car, p, { isPago, payload, chaveExibicao, nomeRecebedor }) {
  const parcelaTxt = `${p.numeroParcela}/${car.numParcelas}`;
  const veiculoTxt = `${car.marca} ${car.modelo} (${car.ano || '-'})`;

  const pixBlock = isPago
    ? `<div class="paid-stamp">PAGO<small>${formatDate(p.dataPagamento)}</small></div>`
    : `<div class="qr">${buildPixQrSvg(payload)}</div>
       <div class="qr-caption">Pague com PIX</div>`;

  return `
    <div class="slip">
      <div class="stub">
        <div class="stub-title">Canhoto</div>
        <div class="field"><span>Parcela</span><strong>${escapeHtml(parcelaTxt)}</strong></div>
        <div class="field"><span>Vencimento</span><strong>${formatDate(p.dataVencimento)}</strong></div>
        <div class="field"><span>Valor</span><strong>${formatMoney(p.valor)}</strong></div>
        <div class="field"><span>Placa</span><strong>${escapeHtml(car.placa)}</strong></div>
        <div class="field"><span>Comprador</span><strong>${escapeHtml(car.comprador || '-')}</strong></div>
        <div class="field"><span>Pago em</span><strong>____/____/______</strong></div>
      </div>
      <div class="main">
        <div class="main-header">
          <span>Carnê de Pagamento</span>
          <strong>Parcela ${escapeHtml(parcelaTxt)}</strong>
        </div>
        <div class="main-body">
          <div class="info">
            <div class="field"><span>Recebedor</span><strong>${escapeHtml(nomeRecebedor)}</strong></div>
            <div class="field"><span>Comprador</span><strong>${escapeHtml(car.comprador || '-')}</strong></div>
            <div class="field"><span>Veículo</span><strong>${escapeHtml(veiculoTxt)} • ${escapeHtml(car.placa)}</strong></div>
            <div class="row">
              <div class="field"><span>Vencimento</span><strong class="big">${formatDate(p.dataVencimento)}</strong></div>
              <div class="field"><span>Valor</span><strong class="big">${formatMoney(p.valor)}</strong></div>
            </div>
            <div class="field"><span>Chave PIX</span><strong>${escapeHtml(chaveExibicao)}</strong></div>
            ${isPago ? '' : `<div class="field"><span>PIX Copia e Cola</span><code>${escapeHtml(payload)}</code></div>`}
          </div>
          <div class="pix">${pixBlock}</div>
        </div>
      </div>
    </div>
  `;
}

function buildCarnetDocumentHtml(car, slipsHtml) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Carnê ${escapeHtml(car.placa)} - ${escapeHtml(car.comprador || '')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; background: #f1f5f9; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; background: #0f172a; color: #fff; position: sticky; top: 0; }
  .toolbar button { background: #2563eb; color: #fff; border: 0; border-radius: 8px; padding: 8px 16px; font-weight: 700; cursor: pointer; }
  .sheet { max-width: 190mm; margin: 16px auto; }
  .slip { display: grid; grid-template-columns: 48mm 1fr; background: #fff; border: 1px solid #333; margin-bottom: 6mm; height: 86mm; break-inside: avoid; page-break-inside: avoid; position: relative; }
  .slip::after { content: '✂'; position: absolute; left: 44.5mm; top: -3mm; font-size: 11px; color: #555; }
  .stub { border-right: 1px dashed #333; padding: 4mm; display: flex; flex-direction: column; gap: 2.2mm; }
  .stub-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #555; }
  .main { display: flex; flex-direction: column; }
  .main-header { display: flex; justify-content: space-between; align-items: center; padding: 2.5mm 4mm; background: #111; color: #fff; font-size: 12px; text-transform: uppercase; }
  .main-header strong { font-size: 14px; }
  .main-body { flex: 1; display: grid; grid-template-columns: 1fr 42mm; gap: 3mm; padding: 3mm 4mm; min-height: 0; }
  .info { display: flex; flex-direction: column; gap: 1.6mm; min-width: 0; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
  .field { display: flex; flex-direction: column; min-width: 0; }
  .field span { font-size: 7.5px; text-transform: uppercase; color: #555; letter-spacing: 0.5px; }
  .field strong { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .field strong.big { font-size: 15px; }
  .field code { font-family: 'Courier New', monospace; font-size: 6.5px; line-height: 1.25; word-break: break-all; color: #333; }
  .pix { display: flex; flex-direction: column; align-items: center; justify-content: center; border-left: 1px solid #ddd; padding-left: 3mm; }
  .qr { width: 38mm; height: 38mm; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .qr-caption { margin-top: 1.5mm; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .paid-stamp { border: 3px solid #059669; color: #059669; font-size: 22px; font-weight: 800; padding: 3mm 5mm; transform: rotate(-12deg); text-align: center; display: flex; flex-direction: column; }
  .paid-stamp small { font-size: 10px; font-weight: 700; }
  @media print {
    @page { size: A4; margin: 10mm; }
    body { background: #fff; }
    .toolbar { display: none; }
    .sheet { margin: 0; max-width: none; }
    .slip:nth-child(3n) { page-break-after: always; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <span>Carnê de ${escapeHtml(car.comprador || 'comprador')} • ${escapeHtml(`${car.marca} ${car.modelo}`)} • ${escapeHtml(car.placa)}</span>
    <button onclick="window.print()">🖨️ Imprimir / Salvar PDF</button>
  </div>
  <div class="sheet">${slipsHtml}</div>
  <script>window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 300); });<\/script>
</body>
</html>`;
}

// ============================================================================
// CONTRATO DE COMPRA E VENDA COM RESERVA DE DOMÍNIO (.docx)
// ============================================================================
const CONTRATO_VENDEDOR_STORAGE_KEY = 'automanage_toledo_contrato_vendedor';
const CONTRATO_TOTAL_PASSOS = 4;
let contratoPasso = 1;

const CONTRATO_VENDEDOR_PADRAO = {
  nome: 'TOLEDO & TOLEDO MOTORES E MECÂNICA EM GERAL LTDA – ME',
  cnpj: '12.601.048/0001-34',
  logradouro: 'Rua Ricardo Bassoli Cesare',
  numero: '237',
  bairro: 'Jardim das Bandeiras',
  cidade: 'Campinas',
  estado: 'São Paulo',
  jurosMes: '0,671',
  jurosAno: '8,06',
  diasVencimento: 10
};

// ---------- Números e datas por extenso ----------
const EXT_UNIDADES = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const EXT_DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const EXT_CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
const MESES_EXTENSO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function extensoAte999(n) {
  if (n === 100) return 'cem';
  const partes = [];
  const c = Math.floor(n / 100);
  const r = n % 100;
  if (c) partes.push(EXT_CENTENAS[c]);
  if (r > 0 && r < 20) partes.push(EXT_UNIDADES[r]);
  else if (r >= 20) partes.push(EXT_DEZENAS[Math.floor(r / 10)] + (r % 10 ? ` e ${EXT_UNIDADES[r % 10]}` : ''));
  return partes.join(' e ');
}

function numeroPorExtenso(valor) {
  let n = Math.floor(Math.abs(Number(valor) || 0));
  if (n === 0) return 'zero';
  const escalas = [
    [1e9, 'um bilhão', 'bilhões'],
    [1e6, 'um milhão', 'milhões'],
    [1e3, 'mil', 'mil'],
    [1, null, null]
  ];
  const grupos = [];
  for (const [base, singular, plural] of escalas) {
    const g = Math.floor(n / base);
    n %= base;
    if (!g) continue;
    let texto;
    if (base === 1) texto = extensoAte999(g);
    else if (g === 1) texto = singular;
    else texto = `${extensoAte999(g)} ${plural}`;
    grupos.push({ texto, valor: g });
  }
  return grupos.reduce((acc, g, i) => {
    if (i === 0) return g.texto;
    const ultimo = i === grupos.length - 1;
    const usaE = ultimo && (g.valor < 100 || g.valor % 100 === 0);
    return `${acc}${usaE ? ' e ' : ' '}${g.texto}`;
  }, '');
}

function valorPorExtenso(valor) {
  const total = Math.round((Number(valor) || 0) * 100);
  const reais = Math.floor(total / 100);
  const centavos = total % 100;
  const partes = [];
  if (reais > 0) {
    const sufixo = reais === 1 ? 'real' : (reais % 1e6 === 0 ? 'de reais' : 'reais');
    partes.push(`${numeroPorExtenso(reais)} ${sufixo}`);
  }
  if (centavos > 0) partes.push(`${numeroPorExtenso(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`);
  return partes.length ? partes.join(' e ') : 'zero reais';
}

function capitalizar(texto) {
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : texto;
}

function formatarReaisContrato(valor) {
  return `R$ ${(Number(valor) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function valorContrato(valor, maiuscula = false) {
  const extenso = valorPorExtenso(valor);
  return `${formatarReaisContrato(valor)} (${maiuscula ? capitalizar(extenso) : extenso})`;
}

function dataPorExtenso(iso) {
  const [a, m, d] = String(iso || '').split('-').map(Number);
  if (!a || !m || !d) return '';
  return `${d} de ${MESES_EXTENSO[m - 1]} de ${a}`;
}

function dataCurta(iso) {
  const [a, m, d] = String(iso || '').split('-');
  return a && m && d ? `${d}/${m}/${a}` : '';
}

function parseNumeroBR(texto) {
  const limpo = String(texto ?? '').trim().replace(/\s|R\$/g, '');
  if (!limpo) return 0;
  const normalizado = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
  return Number(normalizado) || 0;
}

function formatarPercentual(valor, casas) {
  return (Number(valor) || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

function formatarCpf(texto) {
  const d = String(texto || '').replace(/\D/g, '').slice(0, 11);
  if (d.length !== 11) return d;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function cpfValido(texto) {
  const d = String(texto || '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (let t = 9; t < 11; t++) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(d[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(d[t])) return false;
  }
  return true;
}

// ---------- Texto do contrato (modelo de reserva de domínio) ----------
function montarFormaPagamentoContrato(pg) {
  const partes = [];
  if (pg.entrada > 0) partes.push(`uma entrada de ${valorContrato(pg.entrada)}`);
  pg.intermediarias.forEach(p => {
    partes.push(`uma parcela no valor de ${valorContrato(p.valor)} no dia ${dataCurta(p.data)}`);
  });
  if (pg.numParcelas === 1) {
    partes.push(`1 parcela no valor de ${valorContrato(pg.valorParcela)} a ser paga até o dia ${dataCurta(pg.primeiroVencimento)}`);
  } else if (pg.numParcelas > 1) {
    partes.push(`${pg.numParcelas} parcelas mensais, no valor de ${valorContrato(pg.valorParcela)} sendo certo que a primeira parcela deverá ser paga até o dia ${dataCurta(pg.primeiroVencimento)} e as sucedentes com data de vencimento sempre no mesmo dia dos meses subsequentes`);
  }
  if (partes.length === 0) return 'à vista';
  return partes.reduce((acc, parte, i) => {
    if (i === 0) return parte;
    const separador = (i === 1 && pg.entrada > 0) ? ' mais ' : ', mais ';
    return acc + separador + parte;
  }, '');
}

function montarParagrafosContrato(d) {
  const v = d.vendedor;
  const c = d.comprador;
  const veic = d.veiculo;
  const pg = d.pagamento;
  const garantia = veic.garantiaDias > 0
    ? `Com garantia de ${veic.garantiaDias} dias(${numeroPorExtenso(veic.garantiaDias)}) ${veic.garantiaItens}.`.replace(/\s+\./, '.')
    : '';
  const dataAssinatura = d.dataAssinatura ? dataCurta(d.dataAssinatura) : '______/______/______';
  const localData = `${v.cidade}, ${dataAssinatura}`;
  const linha = '________________________________';
  const linhaLonga = '____________________________________________';
  const corTexto = [veic.cor, veic.combustivel].filter(Boolean).join(' ').toUpperCase();
  const compradorNome = c.nome.toUpperCase();

  const termo = `Pelo presente instrumento de confissão de dívida e avença, contida nos termos e forma subjacente, constituem entre si, justo e acertado fiel e valioso contrato parcelamento de dívida para aquisição de automóvel, com clausula de reserva de domínio, entre si: VENDEDOR/CREDOR(A): ${v.nome}, inscrito no CNPJ/MF sob o n ${v.cnpj}, residente e domiciliado à ${v.logradouro}, ${v.bairro}, N: ${v.numero}, Município de ${v.cidade}, Estado de ${v.estado} e PROMITENTE PAGADOR(A) DEVEDOR(A): ${compradorNome}, ${c.nacionalidade}, portador do RG: ${c.rg} inscrita no CPF/MF sob o N: CPF ${c.cpf} residente e domiciliado(a) À ${c.logradouro} N. ${c.numero} ${c.bairro}, Município de ${c.cidade}, Estado de ${c.estado} DO OBJETO DA AVENÇA/DÍVIDA: Mútuo utilizado na compra do automóvel, o veículo é entregue nesta data de ${dataPorExtenso(veic.dataEntrega)}, inspecionado pelo COMPRADOR de propriedade do vendedor(a) Marca /Modelo: ${veic.marcaModelo}, ANO/MODELO: ${veic.anoModelo}, cor ${corTexto}, Placa ${veic.placa}, RENAVAM ${veic.renavam}, CHASSI: ${veic.chassi}, Livre e desembaraçado de ônus.${garantia ? ' ' + garantia : ''} DÍVIDA CONFESSA: De forma livre, voluntária, consciente, a parte confitente reconhece que passará ser devedor do presente título executivo oferecido como garantia do pagamento veículo qualificado no item acima, adquirido da parte credora na importância de ${valorContrato(pg.valorTotal, true)} As partes concordam que o valor da dívida consignada no presente instrumento - título executivo - deverá ser paga de forma parcelada, nas condições abaixo descritas, ou mesmo, com a quitação integral a qualquer momento. Considerar-se-ão vencidas todas as parcelas sucessivas àquela que se achar vencida e não paga no prazo máximo de ${pg.diasVencimento} dias da data do pagamento. DOS ENCARGOS: (Juros Compensatórios) Para efeito de correção monetária, a parte credora está ciente e concordou com a aplicação de juros compensatórios sobre o valor tomado, no valor de ${pg.jurosMes}% ao mês, ${pg.jurosAno} % ao ano e em forma de capitalização (CC de 2002, art. 406 c/c o art. 161, § 1. °, do CTN). DA FORMA DE PAGAMENTO: A parte devedora pagará à parte credora o valor de ${valorContrato(pg.valorTotal, true)}, sendo ${montarFormaPagamentoContrato(pg)}. O pagamento deverá ser efetuado diretamente em uma das contas de titularidade da credora por chave pix ou boleto bancário. O pagamento de denominada parcela não justifica contumaz faz prova de quitação das parcelas anteriores. A prova do pagamento será somente por meio de recibo de pagamento. Em caso de inadimplência das obrigações haverá responsabilização do causador que passará a ser obrigado a arcar com os encargos seja na via administrativa e/ou judiciais.`;

  const contrato = `CONTRATO DE COMPRA E VENDA DE VEÍCULOS COM CLAUSULA DE RESERVA DE DOMINIO O PRESENTE CONTRATO REGER-SE-Á PELAS SEGUINTES CLAUSULAS E CONDIÇÕES: 1ª – DA PROMEÇA DE PAGAMENTO: O devedor promete pagar a dívida, certa, liquida e exequível até a data do seu vencimento, mensalmente à credora ou a sua ordem por meio de crédito direito em conta corrente de sua titularidade ou em espécie no endereço comercial desta ou ainda, mediante pagamento do carnê de pagamento. 2ª – DO OBJETO E DO PREÇO: O presente instrumento formaliza em termos as obrigações sinalagmática entre direitos e deveres das partes contratantes, concernente a compra do veículo descrito acima em campo específico do termo de confissão de dívida, que deverá ser entre pela parte vendedora/credora e das disposições de tudo aquilo no termo de confisco de dívida dispõem sobre o valor do objeto e da forma de pagamento, uma vez que é parte integrante do presente contrato de compra e venda. 3ª - INADIMPLEMENTO: As partes ajustam as obrigações acima constituídas e se prometem entre si o fiel cumprimento das condições e pontualidade, sob pena de rescisão contratual com indenização de perdas e danos. Fica também ajustado no presente termo que qualquer atraso em qualquer uma das obrigações de pagamento, pagamento dos encargos legais e ou deterioração dolosa e acidental do bem acarretarão o vencimento antecipado de todas as demais parcelas vincendas e a liberalidade do credor promover a antecipação do vencimento de demais parcelas e encargos para a data de vencimento mais próximo sob pena de rescisão do presente contrato com a reintegração do automóvel ao credor e indenização de perdas e danos. 4º - DA RESERVA DE DOMINIO: Em virtude e por força do pacto “RESERVA DE DOMINIO” o credor expressamente institui com aquiescência do devedor que declara o aceite com a assinatura do acordo que ficará reservado o domínio pleno do veículo objeto deste contrato cuja transferência definitiva de direito ficará condicionada ao pagamento integral do preço ou de outras formas de extinção da obrigação validamente prevista no Código Civil. O devedor está ciente de que somente poderá exigir a transferência de propriedade via CRV – certificado de registro de veículo - com a apresentação dos recibos de pagamento de todas as parcelas assumidas. 5ª - DA VALIDADE: A validação dos direitos e deveres ficam reservadas a assinatura do presente instrumento, sendo certo e conhecido que neste ato a alienante/credora lhe transmite por tradição a posse precária do veículo, podendo, em caso de descumprimento de qualquer das condições assumidas, em especial destaque para aquelas concernentes ao pagamento e conservação do veículo, será requerido extrajudicialmente ou por meio de ação de judicial de busca e apreensão a reintegração de posso do veículo até o oferecimento de nova garantia ou nova negociação transigência e ou quitação da dívida. 6ª- DO JUROS, TARIFAS E CLAUSULAS PENAIS: O promitente e pagador fica previamente cientificado das taxas de juros, tarifas, correção monetária e clausulas penais concernentes ao contrato de parcelamento do preço pago ao veículo adquirido ficando responsabilizado na condição de devedor em qualquer hipótese de inadimplemento, impontualidade das prestações assumidas por força do presente termo de assunção de dívida mais indenização de perdas e danos comprovadamente produzidos em face do alienante/credora. 7ª - DOS EFEITOS DA INADIMPLENCIA IMPONTUALIDADE: O promissário pagador fica ciente de que em caso de ser necessário ação de cobrança extrajudicial, ou judicial fica autorizado imediatamente retomada do automóvel alienado em garantia da dívida bem como autoriza o distrato do acordo de compra e venda, fincando a alienante/credora encarregada da revenda/leilão do automóvel e a prestar contas ao alienante/credora do fruto da revenda e dos gastos inerentes ao distrato, cobranças, ações judiciais. Remanescendo crédito a alienante/credora se compromete a devolver os ativos ao promitente pagador. 8ª DA RESCISÃO E DA LIQUIDAÇÃO DA DÍVIDA: No caso de não se satisfazer o valor da dívida assumida pelo promitente pagador nos caso de revenda/leilão previsto no item 6ª do presente instrumento, a credora terá legalidade de continuar as cobranças do promitente pagador do saldo negativo. 9ª – DAS OBRIGAÇÕES ADMINISTRATIVAS E OBRIGACIONAIS: Registra-se que é de livre e espontânea escolha o veículo e acessórios nas atuais condições sendo ao promitente pagador orientado a refazer análise de procedência, análise de condições de uso e estado de conservação vez que após constar o aceite passará a assumir inteiramente as responsabilidades de manter o veículo com seus acessórios nos mesmíssimos estados de conservação e 2 2 funcionando, até final liquidação obrigacional, sendo-lhe vedado alegar futuramente condições relativas ao veículo ou a condições de pagamento da obrigação para se desonerar-se do quanto assumindo. 10ª - DAS OBRIGAÇÕES ADMINISTRATIVAS: O promitente pagador assume também, de forma exclusiva, total responsabilidade por impostos, taxas, multas, contribuições custas e despesas de qualquer natureza, relativas ao veículo em tela, obrigando-se, mais, a cumprir todas as exigências dos órgãos públicos. 11º - DAS RESPONSABILIDADES: O contraente, ficará encarregado do adimplemento total a alienante/credora de responsabilidade por procedimentos civis, criminais e fiscais, danos, prejuízos, desastres e acidentes, de quaisquer espécies, que venham a ocorrer com o veículo responsabilizando-se perante terceiros, por atos por si praticados, por seus prepostos e mandatários. 12ª - DO BEM FINANCIADO DADO EM GARANTIA: Este contrato, na forma do art. 129, 5° da Lei 6015, de 31 de dezembro de 1973, e em obediência de condições anteriores, será levado ao Registro de Títulos e Documentos do domicílio das partes contratantes, para doravante ser registrado junto ao DENATRAN a reserva de domínio nos quais será mantida até a liquidação da dívida e o cumprimento de todas as obrigações contratuais, ocasião em que será outorgada pela credora/alienante ordem expressa para seu cancelamento ou baixa. 13ª - FIEL DEPOSITÁRIO: O promitente pagador tem plena ciência e aceita assumir a condições de fiel depositário do bem dado em garantia da operação de parcelamento do preço, bem como, todas as responsabilidades assumidas pelo alienante/credora perante. 14ª – DA CAUSA DE VIOLAÇÃO CONTRATUAL - deixar de efetuar o pagamento de quaisquer prestações, nas datas de seus respectivos vencimentos - deixar de cumprir qualquer obrigação por ele expressamente assumida, nos termos deste contrato - ceder, alienar, gravar, transferir ou emprestar a terceiros o veículo em foco - deixar de proteger tal veículo contra quaisquer turbações de terceiros, reservados - infringir o disposto na cláusula 15ª - da clausula in vigilando: quando solicitado, recusar submeter o veículo à vistoria por representante à inspeção da alienante/vendedora - Se o promitente pagador se tornar insolvente - Se o promitente pagador mudando de residência, não comunicar tal fato, 16ª - DA IMPOSSIBILIDADE DE ALIENAÇÃO - Fica reservado apenas a alienante/credora, o direito de ceder, transferir e inclusive caucionar e descontar junto a terceiros, não só este contrato bem a posse do veículo objeto deste contrato: DAS OBSERVAÇÕES GERAIS: O presente contrato de compra e venda com confissão de dívida e ou promessa de pagamento parcelado tem por escopo força de título executivo judicial nos termos do artigo 784 do NCPC – Com base no artigo 525 do NCPC, havendo certeza da mora no pagamento das obrigações o credor poderá executar a cláusula de reserva de domínio passando a ficar na posse do bem até a arrematação. Por ser expressão da verdade, assinam as seguintes:`;

  const vazio = { tipo: 'vazio' };
  return [
    { tipo: 'titulo', texto: 'TERMO DE CONFISSÃO DE DÍVIDA PROVENIENTE DE COMPRA DE VEÍCULO' },
    { tipo: 'corpo', texto: termo },
    vazio,
    { tipo: 'assinatura', texto: localData },
    vazio, vazio, vazio,
    { tipo: 'assinatura', texto: linha },
    { tipo: 'assinatura', texto: `${compradorNome} Comprador(a)` },
    vazio, vazio, vazio,
    { tipo: 'assinatura', texto: linha },
    { tipo: 'assinatura', texto: v.nome },
    { tipo: 'assinatura', texto: 'Vendedor(a)' },
    vazio, vazio,
    { tipo: 'corpo', texto: contrato },
    vazio,
    { tipo: 'assinatura', texto: localData },
    vazio, vazio,
    { tipo: 'assinatura', texto: linhaLonga },
    { tipo: 'assinatura', texto: `${compradorNome} Comprador(a)` },
    vazio, vazio,
    { tipo: 'assinatura', texto: linhaLonga },
    { tipo: 'assinatura', texto: v.nome },
    { tipo: 'assinatura', texto: 'Vendedor(a)' }
  ];
}

// ---------- Geração do arquivo .docx (OOXML dentro de um ZIP sem compressão) ----------
function xmlEscape(texto) {
  return String(texto ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function paragrafoDocx(p) {
  if (p.tipo === 'vazio') return '<w:p/>';
  const texto = `<w:t xml:space="preserve">${xmlEscape(p.texto)}</w:t>`;
  if (p.tipo === 'titulo') {
    return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="360" w:line="276" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>${texto}</w:r></w:p>`;
  }
  const alinhamento = p.tipo === 'corpo' ? '<w:jc w:val="both"/>' : '';
  return `<w:p><w:pPr>${alinhamento}<w:ind w:firstLine="709"/><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr><w:r>${texto}</w:r></w:p>`;
}

function montarArquivosDocx(paragrafos) {
  const corpo = paragrafos.map(paragrafoDocx).join('');
  const cabecalho = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return {
    '[Content_Types].xml': `${cabecalho}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `${cabecalho}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `${cabecalho}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': `${cabecalho}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`,
    'word/document.xml': `${cabecalho}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${corpo}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1134" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`
  };
}

const CRC32_TABELA = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC32_TABELA[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ZIP no método "stored" (sem compressão): é o que basta para o Word abrir o .docx
function criarZip(arquivos) {
  const enc = new TextEncoder();
  const agora = new Date();
  const dosHora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | Math.floor(agora.getSeconds() / 2);
  const dosData = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
  const locais = [];
  const centrais = [];
  let offset = 0;

  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const nomeBytes = enc.encode(nome);
    const dados = typeof conteudo === 'string' ? enc.encode(conteudo) : conteudo;
    const crc = crc32(dados);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosHora, true);
    local.setUint16(12, dosData, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, dados.length, true);
    local.setUint32(22, dados.length, true);
    local.setUint16(26, nomeBytes.length, true);
    local.setUint16(28, 0, true);
    locais.push(new Uint8Array(local.buffer), nomeBytes, dados);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, dosHora, true);
    central.setUint16(14, dosData, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, dados.length, true);
    central.setUint32(24, dados.length, true);
    central.setUint16(28, nomeBytes.length, true);
    central.setUint32(42, offset, true);
    centrais.push(new Uint8Array(central.buffer), nomeBytes);

    offset += 30 + nomeBytes.length + dados.length;
  }

  const tamanhoCentral = centrais.reduce((acc, b) => acc + b.length, 0);
  const qtd = Object.keys(arquivos).length;
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true);
  fim.setUint16(8, qtd, true);
  fim.setUint16(10, qtd, true);
  fim.setUint32(12, tamanhoCentral, true);
  fim.setUint32(16, offset, true);

  const partes = [...locais, ...centrais, new Uint8Array(fim.buffer)];
  const saida = new Uint8Array(partes.reduce((acc, b) => acc + b.length, 0));
  let pos = 0;
  partes.forEach(b => { saida.set(b, pos); pos += b.length; });
  return saida;
}

function gerarDocxContrato(dados) {
  return criarZip(montarArquivosDocx(montarParagrafosContrato(dados)));
}

// ---------- Tela: assistente em 4 etapas ----------
function loadContratoVendedor() {
  try {
    return { ...CONTRATO_VENDEDOR_PADRAO, ...(JSON.parse(localStorage.getItem(CONTRATO_VENDEDOR_STORAGE_KEY)) || {}) };
  } catch (e) {
    return { ...CONTRATO_VENDEDOR_PADRAO };
  }
}

function saveContratoVendedor(config) {
  try {
    localStorage.setItem(CONTRATO_VENDEDOR_STORAGE_KEY, JSON.stringify(config));
  } catch (e) {
    console.warn('Não foi possível salvar os dados do vendedor:', e);
  }
}

function setCtrValue(id, valor) {
  const el = document.getElementById(id);
  if (el) el.value = valor ?? '';
}

function getCtrValue(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
}

function formatarNumeroCampo(valor) {
  const n = Number(valor) || 0;
  return n ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

function openModalContract(carId = null) {
  if (!requireFullAccess()) return;
  const car = appData.veiculos.find(v => Number(v.id) === Number(carId || currentDetailCarId));
  if (!car) {
    showToast('Selecione um veículo para gerar o contrato.');
    return;
  }

  const salvo = car.contrato || {};
  const comp = salvo.comprador || {};
  const pagSalvo = salvo.pagamento || {};
  const veicSalvo = salvo.veiculo || {};
  const vend = loadContratoVendedor();

  setCtrValue('ctrVehId', car.id);
  document.getElementById('ctrCarName').textContent = `${car.marca} ${car.modelo} • ${car.placa}`;

  // Etapa 1: vendedor (fica salvo neste navegador)
  setCtrValue('ctrVendNome', vend.nome);
  setCtrValue('ctrVendCnpj', vend.cnpj);
  setCtrValue('ctrVendLogradouro', vend.logradouro);
  setCtrValue('ctrVendNumero', vend.numero);
  setCtrValue('ctrVendBairro', vend.bairro);
  setCtrValue('ctrVendCidade', vend.cidade);
  setCtrValue('ctrVendEstado', vend.estado);

  // Etapa 2: comprador (reaproveita o último contrato deste carro)
  setCtrValue('ctrCompNome', comp.nome || car.comprador || '');
  setCtrValue('ctrCompNacionalidade', comp.nacionalidade || 'Brasileiro(a)');
  setCtrValue('ctrCompRg', comp.rg || '');
  setCtrValue('ctrCompCpf', comp.cpf || '');
  setCtrValue('ctrCompLogradouro', comp.logradouro || '');
  setCtrValue('ctrCompNumero', comp.numero || '');
  setCtrValue('ctrCompBairro', comp.bairro || '');
  setCtrValue('ctrCompCidade', comp.cidade || vend.cidade);
  setCtrValue('ctrCompEstado', comp.estado || vend.estado);

  // Etapa 3: veículo (vem do cadastro)
  setCtrValue('ctrVeicMarcaModelo', veicSalvo.marcaModelo || `${car.marca} ${car.modelo}`.trim());
  setCtrValue('ctrVeicAnoModelo', veicSalvo.anoModelo || (car.ano ? String(car.ano) : ''));
  setCtrValue('ctrVeicCor', veicSalvo.cor || car.cor || '');
  setCtrValue('ctrVeicCombustivel', veicSalvo.combustivel || car.combustivel || '');
  setCtrValue('ctrVeicPlaca', car.placa || '');
  setCtrValue('ctrVeicRenavam', car.renavam || '');
  setCtrValue('ctrVeicChassi', car.chassi || car.chassis || '');
  setCtrValue('ctrVeicDataEntrega', veicSalvo.dataEntrega || car.dataVenda || new Date().toISOString().slice(0, 10));
  setCtrValue('ctrVeicGarantiaDias', veicSalvo.garantiaDias ?? 90);
  setCtrValue('ctrVeicGarantiaItens', veicSalvo.garantiaItens || 'no câmbio e no motor');

  // Etapa 4: pagamento (vem da venda registrada)
  const parcelasCarro = appData.pagamentos
    .filter(p => Number(p.veiculoId) === Number(car.id))
    .sort((a, b) => Number(a.numeroParcela) - Number(b.numeroParcela));
  setCtrValue('ctrPagTotal', formatarNumeroCampo(pagSalvo.valorTotal ?? (car.valorVenda || car.valorFipe)));
  setCtrValue('ctrPagEntrada', formatarNumeroCampo(pagSalvo.entrada ?? car.valorEntrada));
  setCtrValue('ctrPagNumParcelas', pagSalvo.numParcelas ?? (car.numParcelas || ''));
  setCtrValue('ctrPagValorParcela', formatarNumeroCampo(pagSalvo.valorParcela ?? car.valorParcela));
  setCtrValue('ctrPagPrimeiroVenc', pagSalvo.primeiroVencimento || (parcelasCarro[0] && parcelasCarro[0].dataVencimento) || '');
  setCtrValue('ctrPagJurosMes', pagSalvo.jurosMes || vend.jurosMes);
  setCtrValue('ctrPagJurosAno', pagSalvo.jurosAno || vend.jurosAno);
  setCtrValue('ctrPagDiasVenc', pagSalvo.diasVencimento ?? vend.diasVencimento);
  setCtrValue('ctrDataAssinatura', salvo.dataAssinatura || '');

  document.getElementById('ctrIntermediariasList').innerHTML = '';
  (pagSalvo.intermediarias || []).forEach(p => addContratoIntermediaria(p));

  goToContratoStep(1);
  updateContratoResumo();
  openModal('modalContract');
}

function addContratoIntermediaria(parcela = {}) {
  const lista = document.getElementById('ctrIntermediariasList');
  const linha = document.createElement('div');
  linha.className = 'ctr-intermediaria';
  linha.innerHTML = `
    <input type="text" inputmode="decimal" class="input-control ctr-int-valor" placeholder="Valor (ex: 11.000,00)" required>
    <input type="date" class="input-control ctr-int-data" required>
    <button type="button" class="btn btn-danger btn-sm" title="Remover parcela">&times;</button>
  `;
  linha.querySelector('.ctr-int-valor').value = formatarNumeroCampo(parcela.valor);
  linha.querySelector('.ctr-int-data').value = parcela.data || '';
  linha.querySelector('.ctr-int-valor').addEventListener('input', updateContratoResumo);
  linha.querySelector('button').addEventListener('click', () => { linha.remove(); updateContratoResumo(); });
  lista.appendChild(linha);
  updateContratoResumo();
}

function onContratoJurosMesChange() {
  const mes = parseNumeroBR(getCtrValue('ctrPagJurosMes'));
  if (mes > 0) setCtrValue('ctrPagJurosAno', formatarPercentual((Math.pow(1 + mes / 100, 12) - 1) * 100, 2));
}

function onContratoCpfInput(input) {
  const digitos = input.value.replace(/\D/g, '').slice(0, 11);
  let f = digitos;
  if (digitos.length > 9) f = `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-${digitos.slice(9)}`;
  else if (digitos.length > 6) f = `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6)}`;
  else if (digitos.length > 3) f = `${digitos.slice(0, 3)}.${digitos.slice(3)}`;
  input.value = f;
}

function goToContratoStep(passo) {
  contratoPasso = Math.min(Math.max(passo, 1), CONTRATO_TOTAL_PASSOS);
  document.querySelectorAll('#modalContract .ctr-step').forEach(sec => {
    sec.style.display = Number(sec.dataset.step) === contratoPasso ? 'block' : 'none';
  });
  document.querySelectorAll('#modalContract .wizard-step').forEach(ind => {
    const n = Number(ind.dataset.step);
    ind.classList.toggle('active', n === contratoPasso);
    ind.classList.toggle('done', n < contratoPasso);
  });
  const ultimo = contratoPasso === CONTRATO_TOTAL_PASSOS;
  document.getElementById('ctrBtnVoltar').style.visibility = contratoPasso === 1 ? 'hidden' : 'visible';
  document.getElementById('ctrBtnAvancar').style.display = ultimo ? 'none' : 'inline-flex';
  document.getElementById('ctrBtnGerar').style.display = ultimo ? 'inline-flex' : 'none';
  if (ultimo) updateContratoResumo();
  const primeiro = document.querySelector(`#modalContract .ctr-step[data-step="${contratoPasso}"] input`);
  if (primeiro) setTimeout(() => primeiro.focus(), 50);
}

function validarPassoContrato(passo, mostrar = true) {
  const secao = document.querySelector(`#modalContract .ctr-step[data-step="${passo}"]`);
  const campos = secao ? Array.from(secao.querySelectorAll('input, select')) : [];
  for (const campo of campos) {
    if (!campo.checkValidity()) {
      if (mostrar) campo.reportValidity();
      return false;
    }
  }
  if (passo === 2 && !cpfValido(getCtrValue('ctrCompCpf'))) {
    if (mostrar) {
      alert('CPF do comprador inválido. Confira os números.');
      document.getElementById('ctrCompCpf').focus();
    }
    return false;
  }
  if (passo === 4) {
    if (parseNumeroBR(getCtrValue('ctrPagTotal')) <= 0) {
      if (mostrar) alert('Informe o valor total do veículo.');
      return false;
    }
    const numParcelas = Number(getCtrValue('ctrPagNumParcelas')) || 0;
    if (numParcelas > 0 && (parseNumeroBR(getCtrValue('ctrPagValorParcela')) <= 0 || !getCtrValue('ctrPagPrimeiroVenc'))) {
      if (mostrar) alert('Informe o valor e o vencimento da primeira parcela mensal.');
      return false;
    }
  }
  return true;
}

function nextContratoStep() {
  if (!validarPassoContrato(contratoPasso)) return;
  goToContratoStep(contratoPasso + 1);
}

function prevContratoStep() {
  goToContratoStep(contratoPasso - 1);
}

function coletarDadosContrato() {
  const intermediarias = Array.from(document.querySelectorAll('#ctrIntermediariasList .ctr-intermediaria')).map(linha => ({
    valor: parseNumeroBR(linha.querySelector('.ctr-int-valor').value),
    data: linha.querySelector('.ctr-int-data').value
  })).filter(p => p.valor > 0);

  return {
    vendedor: {
      nome: getCtrValue('ctrVendNome'),
      cnpj: getCtrValue('ctrVendCnpj'),
      logradouro: getCtrValue('ctrVendLogradouro'),
      numero: getCtrValue('ctrVendNumero'),
      bairro: getCtrValue('ctrVendBairro'),
      cidade: getCtrValue('ctrVendCidade'),
      estado: getCtrValue('ctrVendEstado')
    },
    comprador: {
      nome: getCtrValue('ctrCompNome'),
      nacionalidade: getCtrValue('ctrCompNacionalidade'),
      rg: getCtrValue('ctrCompRg'),
      cpf: formatarCpf(getCtrValue('ctrCompCpf')),
      logradouro: getCtrValue('ctrCompLogradouro'),
      numero: getCtrValue('ctrCompNumero'),
      bairro: getCtrValue('ctrCompBairro'),
      cidade: getCtrValue('ctrCompCidade'),
      estado: getCtrValue('ctrCompEstado')
    },
    veiculo: {
      marcaModelo: getCtrValue('ctrVeicMarcaModelo'),
      anoModelo: getCtrValue('ctrVeicAnoModelo'),
      cor: getCtrValue('ctrVeicCor'),
      combustivel: getCtrValue('ctrVeicCombustivel'),
      placa: getCtrValue('ctrVeicPlaca').toUpperCase(),
      renavam: getCtrValue('ctrVeicRenavam'),
      chassi: getCtrValue('ctrVeicChassi').toUpperCase(),
      dataEntrega: getCtrValue('ctrVeicDataEntrega'),
      garantiaDias: Number(getCtrValue('ctrVeicGarantiaDias')) || 0,
      garantiaItens: getCtrValue('ctrVeicGarantiaItens')
    },
    pagamento: {
      valorTotal: parseNumeroBR(getCtrValue('ctrPagTotal')),
      entrada: parseNumeroBR(getCtrValue('ctrPagEntrada')),
      intermediarias,
      numParcelas: Number(getCtrValue('ctrPagNumParcelas')) || 0,
      valorParcela: parseNumeroBR(getCtrValue('ctrPagValorParcela')),
      primeiroVencimento: getCtrValue('ctrPagPrimeiroVenc'),
      jurosMes: getCtrValue('ctrPagJurosMes'),
      jurosAno: getCtrValue('ctrPagJurosAno'),
      diasVencimento: Number(getCtrValue('ctrPagDiasVenc')) || 0
    },
    dataAssinatura: getCtrValue('ctrDataAssinatura')
  };
}

function somaPagamentoContrato(pg) {
  return pg.entrada + pg.intermediarias.reduce((acc, p) => acc + p.valor, 0) + pg.numParcelas * pg.valorParcela;
}

function updateContratoResumo() {
  const box = document.getElementById('ctrResumo');
  if (!box) return;
  const pg = coletarDadosContrato().pagamento;
  const soma = somaPagamentoContrato(pg);
  const totalIntermediarias = pg.intermediarias.reduce((a, p) => a + p.valor, 0);
  const diferenca = Math.round((pg.valorTotal - soma) * 100) / 100;
  const ok = Math.abs(diferenca) < 0.01;
  box.style.borderLeftColor = ok ? 'var(--success)' : 'var(--warning)';
  box.innerHTML = `
    Entrada ${formatMoney(pg.entrada)} + ${pg.intermediarias.length} intermediária(s) ${formatMoney(totalIntermediarias)}
    + ${pg.numParcelas}x ${formatMoney(pg.valorParcela)} = <strong>${formatMoney(soma)}</strong><br>
    ${ok
      ? `<strong style="color: var(--success);">✅ Confere com o valor total de ${formatMoney(pg.valorTotal)}.</strong>`
      : `<strong style="color: var(--warning);">⚠️ Diferença de ${formatMoney(diferenca)} em relação ao valor total (${formatMoney(pg.valorTotal)}).</strong>`}
  `;
}

function nomeArquivoContrato(dados) {
  const base = `Contrato ${dados.veiculo.placa} - ${dados.comprador.nome}`
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .-]/g, '').replace(/\s+/g, ' ').trim();
  return `${base || 'Contrato'}.docx`;
}

function handleGenerateContract(e) {
  e.preventDefault();
  if (!requireFullAccess()) return;
  for (let passo = 1; passo <= CONTRATO_TOTAL_PASSOS; passo++) {
    if (!validarPassoContrato(passo, false)) {
      goToContratoStep(passo);
      setTimeout(() => validarPassoContrato(passo), 60);
      return;
    }
  }

  const dados = coletarDadosContrato();
  const soma = somaPagamentoContrato(dados.pagamento);
  if (Math.abs(dados.pagamento.valorTotal - soma) >= 0.01) {
    const ok = confirm(`A soma da entrada e das parcelas (${formatMoney(soma)}) é diferente do valor total (${formatMoney(dados.pagamento.valorTotal)}).\n\nGerar o contrato mesmo assim?`);
    if (!ok) return;
  }

  const blob = new Blob([gerarDocxContrato(dados)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeArquivoContrato(dados);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  // Guarda vendedor e juros para os próximos contratos, e os dados do comprador no veículo
  saveContratoVendedor({
    ...dados.vendedor,
    jurosMes: dados.pagamento.jurosMes,
    jurosAno: dados.pagamento.jurosAno,
    diasVencimento: dados.pagamento.diasVencimento
  });
  const car = appData.veiculos.find(v => Number(v.id) === Number(getCtrValue('ctrVehId')));
  if (car) {
    car.contrato = {
      comprador: dados.comprador,
      veiculo: {
        marcaModelo: dados.veiculo.marcaModelo,
        anoModelo: dados.veiculo.anoModelo,
        cor: dados.veiculo.cor,
        combustivel: dados.veiculo.combustivel,
        dataEntrega: dados.veiculo.dataEntrega,
        garantiaDias: dados.veiculo.garantiaDias,
        garantiaItens: dados.veiculo.garantiaItens
      },
      pagamento: dados.pagamento,
      dataAssinatura: dados.dataAssinatura,
      geradoEm: new Date().toISOString()
    };
    saveDatabase();
  }

  closeModal('modalContract');
  showToast('Contrato gerado! O arquivo .docx foi baixado.');
}
