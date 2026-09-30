const axios = require('axios');
const { config } = require('./config');

const MAX_RETENTATIVAS_429 = 2;
const MAX_ESPERA_RETRY_AFTER_MS = 30000;
const MAX_TENTATIVAS_COLISAO = 3;

const zendeskApi = axios.create({
  baseURL: `https://${config.zendesk.subdomain}.zendesk.com/api/v2`,
  timeout: 15000,
  auth: {
    username: `${config.zendesk.email}/token`,
    password: config.zendesk.apiToken,
  },
  headers: { 'Content-Type': 'application/json' },
});

// 429 significa que o Zendesk não processou a requisição — é seguro repetir
// depois do Retry-After. Evita perder atualizações em disparos em massa.
zendeskApi.interceptors.response.use(null, async (err) => {
  const requestConfig = err.config;
  if (err.response?.status !== 429 || !requestConfig) throw err;

  requestConfig.retentativas429 = (requestConfig.retentativas429 || 0) + 1;
  if (requestConfig.retentativas429 > MAX_RETENTATIVAS_429) throw err;

  const retryAfterSeg = Number(err.response.headers?.['retry-after']);
  const esperaMs = Number.isFinite(retryAfterSeg) && retryAfterSeg > 0
    ? Math.min(retryAfterSeg * 1000, MAX_ESPERA_RETRY_AFTER_MS)
    : 5000;

  await new Promise((resolve) => setTimeout(resolve, esperaMs));
  return zendeskApi.request(requestConfig);
});

async function buscarTicket(ticketId) {
  const { data } = await zendeskApi.get(`/tickets/${ticketId}.json`);
  return data.ticket || {};
}

/**
 * Busca as tags atuais de um ticket. Lança erro se a consulta falhar.
 */
async function buscarTagsDoTicketObrigatorio(ticketId) {
  const ticket = await buscarTicket(ticketId);
  return ticket.tags || [];
}

/**
 * Atualiza ticket: comentário interno + adiciona/remove tags numa única chamada.
 *
 * O campo `tags` do Update Ticket substitui a lista inteira, então:
 * - a leitura das tags é obrigatória (nunca grava a partir de uma lista vazia por erro);
 * - `safe_update` + `updated_stamp` fazem o Zendesk recusar (409) se o ticket
 *   mudou entre a leitura e a gravação — nesse caso relê e tenta de novo.
 */
async function atualizarTicket(ticketId, { comment = '', tagsAdicionar = [], tagsRemover = [], uploads = [] }) {
  for (let tentativa = 1; ; tentativa++) {
    const ticket = await buscarTicket(ticketId);
    const tagsAtuais = ticket.tags || [];

    const tagsFinal = tagsAtuais.filter((tag) => !tagsRemover.includes(tag));
    for (const tag of tagsAdicionar) {
      if (!tagsFinal.includes(tag)) tagsFinal.push(tag);
    }

    const ticketComment = { body: comment, public: false };
    if (uploads.length > 0) ticketComment.uploads = uploads;

    try {
      const { data } = await zendeskApi.put(`/tickets/${ticketId}.json`, {
        ticket: {
          comment: ticketComment,
          tags: tagsFinal,
          safe_update: true,
          updated_stamp: ticket.updated_at,
        },
      });
      return data;
    } catch (err) {
      if (err.response?.status === 409 && tentativa < MAX_TENTATIVAS_COLISAO) continue;
      throw err;
    }
  }
}

/**
 * Faz upload de arquivo no Zendesk e retorna o token para anexar no comentario.
 */
async function uploadAttachment(filename, fileBuffer, contentType = 'application/pdf') {
  const { data } = await zendeskApi.post('/uploads.json', fileBuffer, {
    params: { filename },
    headers: {
      'Content-Type': contentType,
    },
  });

  return data.upload?.token;
}

module.exports = {
  atualizarTicket,
  buscarTagsDoTicketObrigatorio,
  uploadAttachment,
  updateTicket: atualizarTicket,
};
