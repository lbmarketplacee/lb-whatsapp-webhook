// Webhook do WhatsApp Business API (Meta) — LB Marketplace
// Variável de ambiente na Vercel:
//   WHATSAPP_VERIFY_TOKEN  (o mesmo valor que você vai colar no campo "Verificar token" da Meta)

export default async function handler(req, res) {
  // 1) VERIFICAÇÃO — a Meta chama isso (GET) só na hora de configurar o webhook
  if (req.method === 'GET') {
    const modo = req.query['hub.mode'];
    const tokenRecebido = req.query['hub.verify_token'];
    const desafio = req.query['hub.challenge'];

    const tokenCorreto = process.env.WHATSAPP_VERIFY_TOKEN;

    if (modo === 'subscribe' && tokenRecebido === tokenCorreto) {
      console.log('Webhook do WhatsApp verificado com sucesso.');
      return res.status(200).send(desafio);
    }
    return res.status(403).send('Token de verificação inválido.');
  }

  // 2) RECEBIMENTO DE MENSAGENS — a Meta chama isso (POST) toda vez que chega mensagem/status
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
