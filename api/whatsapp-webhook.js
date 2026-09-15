// Webhook do WhatsApp Business API + Embedded Signup (Meta) — LB Marketplace
// Variáveis de ambiente na Vercel:
//   WHATSAPP_VERIFY_TOKEN, FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
//   FIREBASE_SERVICE_ACCOUNT, OPENAI_API_KEY

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

const LIMITE_MENSAGENS_AUTO = 4; // depois disso, passa pra atendimento humano

const SYSTEM_PROMPT_LBIA_WHATSAPP = `Você é a atendente virtual da LB Marketplace Assessoria, uma agência especializada em gestão de marketplaces (Shopee, Mercado Livre, TikTok Shop, Shein) para lojistas, distribuidores, fabricantes e importadores.

Seu papel é conversar com quem entra em contato pelo WhatsApp interessado nos serviços da LB, entender rapidamente a situação da pessoa (tipo de negócio, se já vende em marketplace, faturamento aproximado) e ser simpática, natural e prestativa — como uma pessoa da equipe comercial responderia.

Regras importantes:
- Seja breve (2-4 frases por mensagem, tom de WhatsApp, não de e-mail formal).
- Nunca invente preços, prazos ou condições específicas de contrato — se perguntarem valores, diga que um especialista vai detalhar isso na conversa.
- Não prometa resultados específicos de faturamento/vendas.
- Se a pessoa pedir pra falar com um humano, ou fizer uma pergunta muito específica/técnica, responda educadamente que já vai chamar alguém da equipe.
- Use linguagem natural brasileira, sem parecer script decorado.`;

async function chamarOpenAI(historico) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: SYSTEM_PROMPT_LBIA_WHATSAPP }, ...historico],
      temperature: 0.7,
      max_tokens: 200
    })
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || 'Desculpa, tive um probleminha aqui. Já vou chamar alguém da equipe pra te ajudar!';
}

async function enviarMensagemWhatsApp(telefone, texto, accessToken, phoneNumberId) {
  await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefone,
      type: 'text',
      text: { body: texto }
    })
  });
}

export default async function handler(req, res) {
  // Headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) return res.status(500).json({ erro: 'Verify Token não configurado.' });

  // ===== AÇÃO: enviar mensagem manual (humano da equipe respondendo) =====
  if (req.method === 'POST' && req.body?.acao === 'enviar_mensagem') {
    try {
      const { telefone, texto } = req.body;
      if (!telefone || !texto) return res.status(400).json({ erro: 'telefone e texto são obrigatórios.' });
      const configSnap = await db.collection('configuracoes').doc('whatsapp').get();
      if (!configSnap.exists) return res.status(400).json({ erro: 'WhatsApp não conectado.' });
      const config = configSnap.data();
      await enviarMensagemWhatsApp(telefone, texto, config.access_token, config.phone_number_id);
      const convRef = db.collection('whatsappConversas').doc(telefone);
      await convRef.set({
        modo: 'humano',
        mensagens: FieldValue.arrayUnion({ de: 'equipe', texto, em: new Date().toISOString() }),
        ultimaMensagemEm: FieldValue.serverTimestamp()
      }, { merge: true });
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ erro: e.message });
    }
  }

  // ===== AÇÃO: assumir/retomar conversa (humano assume, ou devolve pra IA) =====
  if (req.method === 'POST' && req.body?.acao === 'definir_modo') {
    try {
      const { telefone, modo } = req.body;
      if (!telefone || !modo) return res.status(400).json({ erro: 'telefone e modo são obrigatórios.' });
      await db.collection('whatsappConversas').doc(telefone).set({ modo }, { merge: true });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  // ===== ROTA: Troca code por access_token (vem do Embedded Signup) =====
  if (req.method === 'POST' && req.body?.code) {
    try {
      const { code } = req.body || {};
      if (!code) return res.status(400).json({ erro: 'code é obrigatório.' });

      const appId = process.env.FACEBOOK_APP_ID;
      const appSecret = process.env.FACEBOOK_APP_SECRET;

      if (!appId || !appSecret) {
        return res.status(500).json({ erro: 'Credenciais do Facebook não configuradas.' });
      }

      // 1) Trocar code por short-lived token (fluxo via SDK do JavaScript não usa redirect_uri)
      const tokenResp = await fetch(
        `https://graph.facebook.com/v20.0/oauth/access_token?` +
        `client_id=${appId}&client_secret=${appSecret}&code=${code}`,
        { method: 'GET' }
      );

      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        console.error('Erro ao trocar code:', err);
        return res.status(400).json({ erro: 'Falha ao trocar o código por token.' });
      }

      const tokenData = await tokenResp.json();
      const shortLivedToken = tokenData.access_token;

      if (!shortLivedToken) {
        return res.status(400).json({ erro: 'Nenhum token recebido da Meta.' });
      }

      // 2) Estender o token pra 60 dias (long-lived)
      const extendResp = await fetch(
        `https://graph.facebook.com/v20.0/oauth/access_token?` +
        `grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`,
        { method: 'GET' }
      );

      if (!extendResp.ok) {
        console.error('Erro ao estender token');
        return res.status(400).json({ erro: 'Falha ao estender o token.' });
      }

      const extendedData = await extendResp.json();
      const longLivedToken = extendedData.access_token;

      // 3) Buscar os dados da conta WhatsApp (WABA ID, número de telefone, etc)
      const meResp = await fetch(
        `https://graph.facebook.com/v20.0/me?fields=id,name,email,phone_numbers,whatsapp_business_accounts&access_token=${longLivedToken}`
      );

      if (!meResp.ok) {
        console.error('Erro ao buscar dados da conta');
        return res.status(400).json({ erro: 'Falha ao buscar dados da conta WhatsApp.' });
      }

      const meData = await meResp.json();

      // 4) Extrair WABA ID e phone_number_id
      const wabaList = meData.whatsapp_business_accounts?.data || [];
      if (!wabaList.length) {
        return res.status(400).json({ erro: 'Nenhuma conta WhatsApp Business encontrada.' });
      }

      const waba = wabaList[0];
      const wabaId = waba.id;

      // Buscar o phone_number_id dentro do WABA
      const wabaDetailsResp = await fetch(
        `https://graph.facebook.com/v20.0/${wabaId}?fields=id,name,phone_numbers&access_token=${longLivedToken}`
      );

      if (!wabaDetailsResp.ok) {
        console.error('Erro ao buscar detalhes da WABA');
        return res.status(400).json({ erro: 'Falha ao buscar detalhes da conta.' });
      }

      const wabaDetails = await wabaDetailsResp.json();
      const phoneNumbers = wabaDetails.phone_numbers?.data || [];

      if (!phoneNumbers.length) {
        return res.status(400).json({ erro: 'Nenhum número de telefone encontrado.' });
      }

      const phone = phoneNumbers[0];
      const phoneNumberId = phone.id;
      const phoneNumber = phone.phone_number || phone.display_phone_number || '(não disponível)';

      // Retorna os dados (o frontend salva no Firestore)
      return res.status(200).json({
        ok: true,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        phone_number: phoneNumber,
        access_token: longLivedToken,
        message: 'Token gerado com sucesso!'
      });

    } catch (e) {
      console.error('Erro ao trocar token:', e);
      return res.status(500).json({ erro: 'Erro interno: ' + (e.message || 'desconhecido') });
    }
  }

  // ===== VERIFICAÇÃO — a Meta chama isso (GET) na hora de configurar o webhook =====
  if (req.method === 'GET') {
    const modo = req.query['hub.mode'];
    const tokenRecebido = req.query['hub.verify_token'];
    const desafio = req.query['hub.challenge'];

    if (modo === 'subscribe' && tokenRecebido === verifyToken) {
      console.log('Webhook do WhatsApp verificado com sucesso.');
      return res.status(200).send(desafio);
    }
    return res.status(403).send('Token de verificação inválido.');
  }

  // ===== RECEBIMENTO DE MENSAGENS — a Meta chama isso (POST) quando chega mensagem =====
  if (req.method === 'POST') {
    try {
      const corpo = req.body;

      const valor = corpo?.entry?.[0]?.changes?.[0]?.value;
      const mensagemRecebida = valor?.messages?.[0];

      // Se não for uma mensagem de texto de verdade (pode ser status de entrega, etc), só confirma e sai
      if (!mensagemRecebida || mensagemRecebida.type !== 'text') {
        return res.status(200).send('EVENT_RECEIVED');
      }

      const telefone = mensagemRecebida.from;
      const textoRecebido = mensagemRecebida.text?.body || '';

      // Busca a configuração da conta (token, phone_number_id) pra poder responder
      const configSnap = await db.collection('configuracoes').doc('whatsapp').get();
      if (!configSnap.exists) return res.status(200).send('EVENT_RECEIVED');
      const config = configSnap.data();

      // Busca (ou cria) a conversa desse número
      const convRef = db.collection('whatsappConversas').doc(telefone);
      const convSnap = await convRef.get();
      const conversa = convSnap.exists ? convSnap.data() : { modo: 'auto', mensagens: [], telefone };

      // Salva a mensagem recebida no histórico
      conversa.mensagens = conversa.mensagens || [];
      conversa.mensagens.push({ de: 'lead', texto: textoRecebido, em: new Date().toISOString() });

      const totalTrocasAuto = conversa.mensagens.filter(m => m.de === 'ia').length;

      if (conversa.modo === 'auto' && totalTrocasAuto < LIMITE_MENSAGENS_AUTO) {
        // Monta o histórico no formato da OpenAI (só as últimas 10 mensagens, pra não ficar gigante)
        const historicoOpenAI = conversa.mensagens.slice(-10).map(m => ({
          role: m.de === 'lead' ? 'user' : 'assistant',
          content: m.texto
        }));
        const respostaIA = await chamarOpenAI(historicoOpenAI);

        conversa.mensagens.push({ de: 'ia', texto: respostaIA, em: new Date().toISOString() });
        await enviarMensagemWhatsApp(telefone, respostaIA, config.access_token, config.phone_number_id);

        // Se acabou de bater o limite, já deixa marcado pra passar pro humano na próxima
        if (totalTrocasAuto + 1 >= LIMITE_MENSAGENS_AUTO) {
          conversa.modo = 'aguardando_humano';
        }
      } else if (conversa.modo === 'auto') {
        conversa.modo = 'aguardando_humano';
      }
      // Se já estava 'aguardando_humano' ou 'humano', não responde nada sozinho — só guarda a mensagem

      conversa.ultimaMensagemEm = FieldValue.serverTimestamp();
      await convRef.set(conversa, { merge: true });

      return res.status(200).send('EVENT_RECEIVED');
    } catch (e) {
      console.error(e);
      return res.status(500).send('Erro interno.');
    }
  }

  return res.status(405).send('Método não permitido.');
}
