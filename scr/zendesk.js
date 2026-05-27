const axios = require('axios');
const { config } = require('./config');

const zendeskApi = axios.create({
  baseURL: `https://${config.zendesk.subdomain}.zendesk.com/api/v2`,
  timeout: 15000,
  auth: {
    username: `${config.zendesk.email}/token`,
    password: config.zendesk.apiToken,
  },
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Busca as tags atuais de um ticket.
 */
async function buscarTagsDoTicketObrigatorio(ticketId) {
  const { data } = await zendeskApi.get(`/tickets/${ticketId}.json`);
  return data.ticket?.tags || [];
}

async function buscarTagsDoTicket(ticketId) {
  try {
    return await buscarTagsDoTicketObrigatorio(ticketId);
  } catch {
    return [];
  }
}

/**
 * Atualiza ticket: comentário interno + adiciona/remove tags.
 * Mesmo padrão do ZTimer — busca tags atuais, manipula, e seta o array completo.
 */
async function atualizarTicket(ticketId, { mensagem, comment, tagsAdicionar = [], tagsRemover = [], status, uploads = [] }) {
  const body = mensagem || comment || '';

  // 1. Buscar tags atuais do ticket
  const tagsAtuais = await buscarTagsDoTicket(ticketId);

  // 2. Remover tags indesejadas
  let tagsFinal = tagsAtuais.filter(tag => !tagsRemover.includes(tag));

  // 3. Adicionar novas tags (sem duplicar)
  for (const tag of tagsAdicionar) {
    if (!tagsFinal.includes(tag)) {
      tagsFinal.push(tag);
    }
  }

  // 4. Montar payload
  const ticketComment = {
    body,
    public: false,
  };

  if (uploads.length > 0) {
    ticketComment.uploads = uploads;
  }

  const ticketUpdate = {
    ticket: {
      comment: ticketComment,
      tags: tagsFinal,
    },
  };

  if (status) {
    ticketUpdate.ticket.status = status;
  }

  const { data } = await zendeskApi.put(`/tickets/${ticketId}`, ticketUpdate);
  return data;
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
  buscarTagsDoTicket,
  buscarTagsDoTicketObrigatorio,
  uploadAttachment,
  updateTicket: atualizarTicket,
};
