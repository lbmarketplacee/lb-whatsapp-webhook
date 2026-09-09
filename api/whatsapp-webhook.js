// Webhook do WhatsApp Business API + Embedded Signup (Meta) — LB Marketplace
// Variáveis de ambiente na Vercel:
//   WHATSAPP_VERIFY_TOKEN
//   FACEBOOK_APP_ID
//   FACEBOOK_APP_SECRET

export default async function handler(req, res) {
  // Headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) return res.status(500).json({ erro: 'Verify Token não configurado.' });

  // ===== ROTA: Troca code por access_token (vem do Embedded Signup) =====
  if (req.url === '/api/whatsapp-exchange-token' && req.method === 'POST') {
    try {
      const { code, user_id } = req.body || {};
      if (!code || !user_id) return res.status(400).json({ erro: 'code e user_id são obrigatórios.' });

      const appId = process.env.FACEBOOK_APP_ID;
      const appSecret = process.env.FACEBOOK_APP_SECRET;
      const redirectUri = 'https://lb-marketplace.vercel.app/whatsapp-callback';

      if (!appId || !appSecret) {
        return res.status(500).json({ erro: 'Credenciais do Facebook não configuradas.' });
      }

      // 1) Trocar code por short-lived token
      const tokenResp = await fetch(
        `https://graph.facebook.com/v20.0/oauth/access_token?` +
        `client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`,
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
      console.log('Webhook do WhatsApp recebeu:', JSON.stringify(corpo));

      // Por enquanto só confirma o recebimento (obrigatório responder 200 rápido).
      // Depois vamos processar as mensagens aqui (ex: salvar no Firestore, disparar CRM, etc).

      return res.status(200).send('EVENT_RECEIVED');
    } catch (e) {
      console.error(e);
      return res.status(500).send('Erro interno.');
    }
  }

  return res.status(405).send('Método não permitido.');
}
