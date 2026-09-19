// Webhook do WhatsApp Business API + Embedded Signup (Meta) — LB Marketplace
// Variáveis de ambiente na Vercel:
// WHATSAPP_VERIFY_TOKEN
// FACEBOOK_APP_ID
// FACEBOOK_APP_SECRET
// FIREBASE_SERVICE_ACCOUNT
// OPENAI_API_KEY

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

const db = getFirestore();

const LIMITE_MENSAGENS_AUTO = 4;

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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT_LBIA_WHATSAPP
        },
        ...historico
      ],
      temperature: 0.7,
      max_tokens: 200
    })
  });

  const data = await resp.json();

  return (
    data.choices?.[0]?.message?.content ||
    'Desculpa, tive um probleminha aqui. Já vou chamar alguém da equipe pra te ajudar!'
  );
}

async function enviarMensagemWhatsApp(
  telefone,
  texto,
  accessToken,
  phoneNumberId
) {
  const resp = await fetch(
    `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: telefone,
        type: 'text',
        text: {
          body: texto
        }
      })
    }
  );

  if (!resp.ok) {
    const erro = await resp.text();
    console.error(
      'Erro ao enviar mensagem WhatsApp:',
      erro
    );
  }
}

// =========================================================
// TROCA DO CODE DO EMBEDDED SIGNUP
// =========================================================

async function trocarCodePorToken(code, appId, appSecret) {

  // Conforme documentação oficial da Meta: SEM redirect_uri, via GET.
  try {
    const url = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`;

    console.log('Trocando code por token (GET, sem redirect_uri)');

    const response = await fetch(url, { method: 'GET' });
    const texto = await response.text();
    console.log('Resposta da troca de code:', texto);

    if (response.ok) {
      try {
        const dados = JSON.parse(texto);
        if (dados.access_token) {
          return { sucesso: true, dados };
        }
      } catch (e) {
        console.error('Resposta não é JSON:', texto);
      }
    }

    return { sucesso: false, erro: texto };

  } catch (erro) {
    console.error('Erro na troca de code:', erro);
    return { sucesso: false, erro: erro.message };
  }
}

export default async function handler(req, res) {

  // =========================================================
  // CORS
  // =========================================================

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, GET, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // =========================================================
  // VERIFY TOKEN
  // =========================================================

  const verifyToken =
    process.env.WHATSAPP_VERIFY_TOKEN;

  if (!verifyToken) {
    return res.status(500).json({
      erro: 'Verify Token não configurado.'
    });
  }

  // =========================================================
  // ENVIO MANUAL DE MENSAGEM
  // =========================================================

  if (
    req.method === 'POST' &&
    req.body?.acao === 'enviar_mensagem'
  ) {

    try {

      const {
        telefone,
        texto
      } = req.body;

      if (!telefone || !texto) {

        return res.status(400).json({
          erro:
            'telefone e texto são obrigatórios.'
        });
      }

      const configSnap =
        await db
          .collection('configuracoes')
          .doc('whatsapp')
          .get();

      if (!configSnap.exists) {

        return res.status(400).json({
          erro:
            'WhatsApp não conectado.'
        });
      }

      const config =
        configSnap.data();

      await enviarMensagemWhatsApp(
        telefone,
        texto,
        config.access_token,
        config.phone_number_id
      );

      const convRef =
        db
          .collection('whatsappConversas')
          .doc(telefone);

      await convRef.set(
        {
          modo: 'humano',

          mensagens:
            FieldValue.arrayUnion({
              de: 'equipe',
              texto,
              em:
                new Date().toISOString()
            }),

          ultimaMensagemEm:
            FieldValue.serverTimestamp()
        },
        {
          merge: true
        }
      );

      return res.status(200).json({
        ok: true
      });

    } catch (e) {

      console.error(e);

      return res.status(500).json({
        erro: e.message
      });
    }
  }

  // =========================================================
  // DEFINIR MODO
  // =========================================================

  if (
    req.method === 'POST' &&
    req.body?.acao === 'definir_modo'
  ) {

    try {

      const {
        telefone,
        modo
      } = req.body;

      if (!telefone || !modo) {

        return res.status(400).json({
          erro:
            'telefone e modo são obrigatórios.'
        });
      }

      await db
        .collection('whatsappConversas')
        .doc(telefone)
        .set(
          {
            modo
          },
          {
            merge: true
          }
        );

      return res.status(200).json({
        ok: true
      });

    } catch (e) {

      return res.status(500).json({
        erro: e.message
      });
    }
  }

  // =========================================================
  // EMBEDDED SIGNUP
  // =========================================================

  if (
    req.method === 'POST' &&
    req.body?.code
  ) {

    try {

      const {
        code
      } = req.body;

      if (!code) {

        return res.status(400).json({
          erro:
            'code é obrigatório.'
        });
      }

      const appId =
        process.env.FACEBOOK_APP_ID;

      const appSecret =
        process.env.FACEBOOK_APP_SECRET;

      if (!appId || !appSecret) {

        return res.status(500).json({
          erro:
            'Credenciais do Facebook não configuradas.'
        });
      }

      console.log(
        '======================================'
      );

      console.log(
        'EMBEDDED SIGNUP RECEBIDO'
      );

      console.log(
        'App ID:',
        appId
      );

      console.log(
        'Code recebido:',
        code ? 'SIM' : 'NÃO'
      );

      console.log(
        '======================================'
      );

      // -----------------------------------------------------
      // TROCAR CODE POR TOKEN
      // -----------------------------------------------------

      const resultado =
        await trocarCodePorToken(
          code,
          appId,
          appSecret
        );

      if (!resultado.sucesso) {

        console.error(
          'TODAS AS TENTATIVAS DE TOKEN FALHARAM:'
        );

        console.error(
          resultado.erro
        );

        return res.status(400).json({
          erro:
            'Falha ao trocar o código por token.',

          detalhe:
            resultado.erro,

          tentativas: [
            'sem redirect_uri',
            'https://sistema.lbmarketplace.com.br/whatsapp-callback.html',
            'https://sistema.lbmarketplace.com.br/'
          ]
        });
      }

      const tokenData =
        resultado.dados;

      const businessToken =
        tokenData.access_token;

      if (!businessToken) {

        return res.status(400).json({
          erro:
            'Nenhum token recebido da Meta.',

          detalhe:
            tokenData
        });
      }

      console.log(
        'TOKEN RECEBIDO COM SUCESSO.'
      );

      // -----------------------------------------------------
      // BUSCAR DADOS DA CONTA
      // -----------------------------------------------------

      const meResp =
        await fetch(
          `https://graph.facebook.com/v23.0/me?fields=id,name,email,whatsapp_business_accounts&access_token=${encodeURIComponent(
            businessToken
          )}`
        );

      const meText =
        await meResp.text();

      if (!meResp.ok) {

        console.error(
          'Erro ao buscar dados da conta:',
          meText
        );

        return res.status(400).json({
          erro:
            'Falha ao buscar dados da conta WhatsApp.',

          detalhe:
            meText
        });
      }

      let meData;

      try {

        meData =
          JSON.parse(meText);

      } catch (e) {

        return res.status(400).json({
          erro:
            'Resposta inválida da Meta.',

          detalhe:
            meText
        });
      }

      // -----------------------------------------------------
      // ENCONTRAR WABA
      // -----------------------------------------------------

      const wabaList =
        meData
          .whatsapp_business_accounts
          ?.data || [];

      if (!wabaList.length) {

        return res.status(400).json({
          erro:
            'Nenhuma conta WhatsApp Business encontrada.',

          detalhe:
            meData
        });
      }

      const waba =
        wabaList[0];

      const wabaId =
        waba.id;

      console.log(
        'WABA encontrada:',
        wabaId
      );

      // -----------------------------------------------------
      // BUSCAR NÚMEROS
      // -----------------------------------------------------

      const wabaDetailsResp =
        await fetch(
          `https://graph.facebook.com/v23.0/${wabaId}?fields=id,name,phone_numbers&access_token=${encodeURIComponent(
            businessToken
          )}`
        );

      const wabaDetailsText =
        await wabaDetailsResp.text();

      if (!wabaDetailsResp.ok) {

        console.error(
          'Erro ao buscar detalhes da WABA:',
          wabaDetailsText
        );

        return res.status(400).json({
          erro:
            'Falha ao buscar detalhes da conta.',

          detalhe:
            wabaDetailsText
        });
      }

      let wabaDetails;

      try {

        wabaDetails =
          JSON.parse(
            wabaDetailsText
          );

      } catch (e) {

        return res.status(400).json({
          erro:
            'Resposta inválida ao buscar detalhes da WABA.',

          detalhe:
            wabaDetailsText
        });
      }

      const phoneNumbers =
        wabaDetails
          .phone_numbers
          ?.data || [];

      if (!phoneNumbers.length) {

        return res.status(400).json({
          erro:
            'Nenhum número de telefone encontrado.',

          detalhe:
            wabaDetails
        });
      }

      // -----------------------------------------------------
      // PEGAR NÚMERO
      // -----------------------------------------------------

      const phone =
        phoneNumbers[0];

      const phoneNumberId =
        phone.id;

      const phoneNumber =
        phone.phone_number ||
        phone.display_phone_number ||
        '(não disponível)';

      console.log(
        'Phone Number ID:',
        phoneNumberId
      );

      console.log(
        'Número:',
        phoneNumber
      );

      // -----------------------------------------------------
      // RETORNAR PARA FRONTEND
      // -----------------------------------------------------

      return res.status(200).json({

        ok: true,

        waba_id:
          wabaId,

        phone_number_id:
          phoneNumberId,

        phone_number:
          phoneNumber,

        access_token:
          businessToken,

        message:
          'Token gerado com sucesso!'
      });

    } catch (e) {

      console.error(
        'Erro no Embedded Signup:',
        e
      );

      return res.status(500).json({

        erro:
          'Erro interno: ' +
          (e.message ||
            'desconhecido'),

        detalhe:
          e.stack || null
      });
    }
  }

  // =========================================================
  // VERIFICAÇÃO DO WEBHOOK
  // =========================================================

  if (req.method === 'GET') {

    const modo =
      req.query['hub.mode'];

    const tokenRecebido =
      req.query['hub.verify_token'];

    const desafio =
      req.query['hub.challenge'];

    if (
      modo === 'subscribe' &&
      tokenRecebido === verifyToken
    ) {

      console.log(
        'Webhook do WhatsApp verificado com sucesso.'
      );

      return res
        .status(200)
        .send(desafio);
    }

    return res
      .status(403)
      .send(
        'Token de verificação inválido.'
      );
  }

  // =========================================================
  // RECEBIMENTO DE MENSAGENS
  // =========================================================

  if (req.method === 'POST') {

    try {

      const corpo =
        req.body;

      const valor =
        corpo
          ?.entry?.[0]
          ?.changes?.[0]
          ?.value;

      const mensagemRecebida =
        valor?.messages?.[0];

      if (
        !mensagemRecebida ||
        mensagemRecebida.type !== 'text'
      ) {

        return res
          .status(200)
          .send(
            'EVENT_RECEIVED'
          );
      }

      const telefone =
        mensagemRecebida.from;

      const textoRecebido =
        mensagemRecebida.text?.body ||
        '';

      // -----------------------------------------------------
      // CONFIGURAÇÃO WHATSAPP
      // -----------------------------------------------------

      const configSnap =
        await db
          .collection('configuracoes')
          .doc('whatsapp')
          .get();

      if (!configSnap.exists) {

        return res
          .status(200)
          .send(
            'EVENT_RECEIVED'
          );
      }

      const config =
        configSnap.data();

      // -----------------------------------------------------
      // CONVERSA
      // -----------------------------------------------------

      const convRef =
        db
          .collection('whatsappConversas')
          .doc(telefone);

      const convSnap =
        await convRef.get();

      const conversa =
        convSnap.exists
          ? convSnap.data()
          : {
              modo: 'auto',
              mensagens: [],
              telefone
            };

      conversa.mensagens =
        conversa.mensagens || [];

      conversa.mensagens.push({
        de: 'lead',
        texto: textoRecebido,
        em:
          new Date().toISOString()
      });

      // -----------------------------------------------------
      // CONTAGEM IA
      // -----------------------------------------------------

      const totalTrocasAuto =
        conversa.mensagens.filter(
          (m) => m.de === 'ia'
        ).length;

      // -----------------------------------------------------
      // IA
      // -----------------------------------------------------

      if (
        conversa.modo === 'auto' &&
        totalTrocasAuto <
          LIMITE_MENSAGENS_AUTO
      ) {

        const historicoOpenAI =
          conversa.mensagens
            .slice(-10)
            .map((m) => ({

              role:
                m.de === 'lead'
                  ? 'user'
                  : 'assistant',

              content:
                m.texto

            }));

        const respostaIA =
          await chamarOpenAI(
            historicoOpenAI
          );

        conversa.mensagens.push({
          de: 'ia',
          texto: respostaIA,
          em:
            new Date().toISOString()
        });

        await enviarMensagemWhatsApp(
          telefone,
          respostaIA,
          config.access_token,
          config.phone_number_id
        );

        if (
          totalTrocasAuto + 1 >=
          LIMITE_MENSAGENS_AUTO
        ) {

          conversa.modo =
            'aguardando_humano';
        }

      } else if (
        conversa.modo === 'auto'
      ) {

        conversa.modo =
          'aguardando_humano';
      }

      // -----------------------------------------------------
      // SALVAR
      // -----------------------------------------------------

      conversa.ultimaMensagemEm =
        FieldValue.serverTimestamp();

      await convRef.set(
        conversa,
        {
          merge: true
        }
      );

      return res
        .status(200)
        .send(
          'EVENT_RECEIVED'
        );

    } catch (e) {

      console.error(e);

      return res
        .status(500)
        .send(
          'Erro interno.'
        );
    }
  }

  return res
    .status(405)
    .send(
      'Método não permitido.'
    );
}
