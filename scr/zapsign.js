const axios = require('axios');
const { config } = require('./config');
const { validateCPF } = require('./utils');

const zapsignApi = axios.create({
  baseURL: config.zapsign.baseUrl,
  timeout: 30000, // 30 segundos
  headers: {
    'Authorization': `Bearer ${config.zapsign.apiToken}`,
    'Content-Type': 'application/json',
  },
});

/**
 * Cria um documento na ZapSign via modelo dinâmico DOCX.
 * Aceita nomes de campos em inglês (vindos do index.js) ou português.
 */
async function criarDocumentoViaModelo(params) {
  const nome = (params.name || params.nome || '').trim();
  const email = params.email || '';
  const telefone = params.phone || params.telefone || '';
  const documento = params.cpf || params.documento || params.passaporte || '';
  const ticketId = params.ticket_id || params.ticketId || '';
  // Prefer the Render/env template so production is not affected by an old
  // sandbox template_id still being sent by Zendesk.
  const templateSource = config.zapsign.templateId ? 'env' : 'request';
  const templateId = config.zapsign.templateId || params.template_id;
  const organizacao = params.organizacao || '';
  const assunto = params.assunto || '';
  const valor = params.valor || '';

  const phoneClean = limparTelefone(telefone);
  const hasPhone = phoneClean.length >= 10;

  const payload = {
    template_id: templateId,
    signer_name: nome,
    signer_email: email || '',
    signer_phone_country: '55',
    signer_phone_number: phoneClean,
    send_automatic_email: !!email,
    send_automatic_whatsapp: hasPhone,
    external_id: `zendesk-${ticketId}`,
    folder_path: '/zendesk/',
    lang: 'pt-br',
    custom_message: hasPhone
      ? `Olá ${nome}, segue o documento referente ao chamado #${ticketId} para sua assinatura. Atenciosamente, Equipe de Suporte`
      : `Olá ${nome},\nSegue o documento referente ao chamado #${ticketId} para sua assinatura.\nAtenciosamente, Equipe de Suporte`,
    data: criarCamposModelo([
      { variaveis: ['NOME COMPLETO', 'NAME', 'CLIENTE'], valor: nome },
      { variaveis: ['CPF', 'PASSAPORTE', 'DOCUMENTO', 'NUMERO DO CPF', 'NUMERO DO DOCUMENTO'], valor: documento },
      { variaveis: ['EMAIL', 'E-MAIL', 'EMAIL DO CLIENTE'], valor: email },
      { variaveis: ['NUMERO_TICKET', 'NUMERO DO TICKET', 'NÚMERO DO TICKET', 'TICKET'], valor: String(ticketId) },
      { variaveis: ['DATA'], valor: new Date().toLocaleDateString('pt-BR') },
      { variaveis: ['ORGANIZACAO', 'ORGANIZAÇÃO'], valor: organizacao },
      { variaveis: ['ASSUNTO'], valor: assunto },
      { variaveis: ['VALOR', 'VALOR DO CONTRATO'], valor },
    ]),
  };

  try {
    const { data } = await zapsignApi.post('/models/create-doc/', payload);
    return data;
  } catch (err) {
    if (
      err.response?.status === 404
      && String(err.response?.data?.detail || '').includes('No Template')
    ) {
      const hint = templateSource === 'env'
        ? 'Verifique se ZAPSIGN_TEMPLATE_ID no Render e o token do modelo da conta de producao.'
        : 'Verifique se o template_id enviado pelo Zendesk e o token do modelo da conta de producao.';
      err.message = `${err.message} - modelo ZapSign nao encontrado. ${hint}`;
    }
    throw err;
  }
}

/**
 * Cria um documento na ZapSign via upload de PDF (URL pública ou base64).
 */
async function criarDocumentoViaUpload(params) {
  const nome = (params.name || params.nome || '').trim();
  const email = params.email || '';
  const telefone = params.phone || params.telefone || '';
  const documento = params.cpf || params.documento || params.passaporte || '';
  const isCpf = validateCPF(documento);
  const ticketId = params.ticket_id || params.ticketId || '';
  const assunto = params.assunto || '';

  const phoneClean = limparTelefone(telefone);
  const hasPhone = phoneClean.length >= 10;

  const payload = {
    name: `Contrato - Ticket #${ticketId} - ${assunto || 'Documento'}`,
    url_pdf: config.zapsign.pdfUrl,
    lang: 'pt-br',
    external_id: `zendesk-${ticketId}`,
    folder_path: '/zendesk/',
    send_automatic_email: !!email,
    signers: [
      {
        name: nome,
        email: email || '',
        phone_country: '55',
        phone_number: phoneClean,
        auth_mode: 'assinaturaTela',
        send_automatic_email: !!email,
        send_automatic_whatsapp: hasPhone,
        lock_name: true,
        lock_email: true,
        require_cpf: isCpf,
        cpf: isCpf ? documento : '',
        custom_message: hasPhone
          ? `Olá ${nome}, segue o documento do chamado #${ticketId} para assinatura.`
          : `Olá ${nome},\nSegue o documento do chamado #${ticketId} para assinatura.`,
      },
    ],
  };

  const { data } = await zapsignApi.post('/docs/', payload);
  return data;
}

/**
 * Função principal — decide entre modelo ou upload conforme configuração.
 */
async function criarDocumento(dadosTicket) {
  if (config.zapsign.templateId || dadosTicket.template_id) {
    return criarDocumentoViaModelo(dadosTicket);
  }

  if (config.zapsign.pdfUrl) {
    return criarDocumentoViaUpload(dadosTicket);
  }

  throw new Error(
    'Nenhuma origem de documento configurada. Defina ZAPSIGN_TEMPLATE_ID ou ZAPSIGN_PDF_URL no .env'
  );
}

/**
 * Consulta os detalhes de um documento na ZapSign.
 */
async function detalharDocumento(docToken) {
  const { data } = await zapsignApi.get(`/docs/${docToken}/`);
  return data;
}

async function baixarArquivoAssinado(doc) {
  let signedFileUrl = doc.signed_file;

  if (!signedFileUrl && doc.token) {
    const detalhes = await detalharDocumento(doc.token);
    signedFileUrl = detalhes.signed_file;
  }

  if (!signedFileUrl) {
    return null;
  }

  const { data, headers } = await axios.get(signedFileUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  return {
    buffer: Buffer.from(data),
    contentType: headers['content-type'] || 'application/pdf',
    url: signedFileUrl,
  };
}

function criarCamposModelo(campos) {
  const vistos = new Set();
  const data = [];

  for (const campo of campos) {
    for (const variavel of campo.variaveis) {
      const de = `{{${variavel}}}`;
      if (vistos.has(de)) continue;
      vistos.add(de);
      data.push({ de, para: campo.valor || '' });
    }
  }

  return data;
}

/**
 * Remove caracteres não numéricos do telefone.
 */
function limparTelefone(telefone) {
  if (!telefone) return '';
  return telefone.replace(/\D/g, '').replace(/^55/, '');
}

module.exports = {
  criarDocumento,
  criarDocumentoViaModelo,
  criarDocumentoViaUpload,
  detalharDocumento,
  baixarArquivoAssinado,
  // alias usado em index.js — aponta pra função principal (com fallback PDF)
  createDocument: criarDocumento,
};
