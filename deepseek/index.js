import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import { obtenerRespuesta } from './deepseek.js';
import { generarOpinionBreve } from './deepseek.js';
import axios from 'axios'; // Asegúrate de tener axios instalado

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  try {
    const respuesta = await obtenerRespuesta(message);
    res.json({ response: respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener respuesta de Deepseek' });
  }
});


app.post('/api/opinion', async (req, res) => {
  const { question, answer } = req.body;
  try {
    const opinion = await generarOpinionBreve(question, answer);
    res.json({ response: opinion });
  } catch (error) {
    res.status(500).json({ error: 'Error generando opinión breve' });
  }
});

app.post('/api/guardar-resultado', async (req, res) => {
  const { nombre, resultado } = req.body;

  try {
    const scriptURL = 'https://script.google.com/macros/s/AKfycbyTma0kkSUAixdlXRPZ_OYyorn4s18YXHK865SQv0FyiyeeDqbsb1_zehD_EHEZ9MCd/exec'; // Reemplaza con tu URL real
    await axios.post(scriptURL, { nombre, resultado });
    res.status(200).json({ ok: true, message: 'Resultado enviado correctamente a Google Sheets.' });
  } catch (error) {
    console.error('Error al enviar a Google Sheets:', error);
    res.status(500).json({ ok: false, error: 'Error al enviar a Google Sheets' });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
