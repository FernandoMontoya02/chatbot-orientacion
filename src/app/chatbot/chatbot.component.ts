import { Component, OnInit, ViewChild, ElementRef, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ChatStorageService, Conversation } from '../services/chat-storage.service';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import html2pdf from 'html2pdf.js';

interface ChatState {
  userName: string;
  messages: { sender: 'user' | 'bot'; text: string }[];
  userAnswers: Record<string, string>;
  questionIndex: number;
  questions: { key: string; text: string }[];
  interestsDescription: string;
  hasName: boolean;
  isCollectingInterests: boolean;
  chatTerminado?: boolean; 
}

@Component({
  selector: 'app-chatbot',
  standalone: true,
  imports: [FormsModule, CommonModule],
  templateUrl: './chatbot.component.html',
  styleUrls: ['./chatbot.component.css'],
})
export class ChatbotComponent implements OnInit {
  private chatStorage = inject(ChatStorageService);
  private http = inject(HttpClient);
  private sanitizer = inject(DomSanitizer);

  @ViewChild('chatContainer') chatContainer!: ElementRef;

  userName = '';
  userMessage = '';
  messages: { sender: 'user' | 'bot'; text: string; html?: SafeHtml }[] = [];
  conversations: Conversation[] = [];
  currentConversation: Conversation | null = null;
  showInvalidAnswerMsg = false;
  hasName = false;
  showMenu = false;
  isLoading = false;
  processCompleted = false;
  chatTerminado = false;
  awaitingFollowUp = false;
  questionIndex = 0;
  userAnswers: Record<string, string> = {};
  questions: { key: string; text: string }[] = [];
  isCollectingInterests = true;
  interestsDescription = '';

  async ngOnInit(): Promise<void> {
    this.conversations = this.chatStorage.getConversations();
    await this.typeBotMessage('¡Hola! Selecciona un usuario del historial o escribe tu nombre para empezar.');
  }

  private saveState(): void {
    if (!this.userName) return;

    const state: ChatState = {
      userName: this.userName,
      messages: this.messages.map(m => ({ sender: m.sender, text: m.text })),
      userAnswers: this.userAnswers,
      questionIndex: this.questionIndex,
      questions: this.questions,
      interestsDescription: this.interestsDescription,
      hasName: this.hasName,
      isCollectingInterests: this.isCollectingInterests,
      chatTerminado: this.chatTerminado
    };

    localStorage.setItem(`chat-state-${this.userName}`, JSON.stringify(state));
  }

  async validateAnswerWithAI(question: string, answer: string): Promise<number> {
    const lowerAnswer = answer.toLowerCase();
    const badPhrases = ['no sé', 'nada', 'ninguna idea', 'lo que sea', 'xD', 'cualquiera'];

    if (answer.trim().length < 25 || badPhrases.some(p => lowerAnswer.includes(p))) {
      return 0; // claramente inválida
    }

    const prompt = `
Eres un orientador vocacional de la Universidad Técnica de Machala (UTMACH).
Analiza la siguiente respuesta a esta pregunta:
Pregunta: "${question}"
Respuesta del estudiante: "${answer}"

Evalúa esta respuesta del 1 al 5 según su nivel de expresión, claridad, utilidad y reflexión vocacional:
1 = Muy pobre, sin sentido
2 = Muy breve o genérica
3 = Aceptable, pero superficial
4 = Buena, con algo de reflexión
5 = Excelente, muy expresiva y útil

Responde SOLO con un número (1 a 5).
`;

    try {
      const res = await this.http.post<{ response: string }>(
        'https://chatbot-orientacion.onrender.com/api/chat',
        { message: prompt }
      ).toPromise();

      const score = parseInt(res?.response?.trim() || '0');
      return isNaN(score) ? 0 : score;
    } catch (error) {
      console.error("Error al validar respuesta con IA:", error);
      return 0;
    }
  }

  async sendMessage(): Promise<void> {
    if (!this.userMessage.trim() || this.chatTerminado) return;

    const userText = this.userMessage.trim();
    this.messages.push({ sender: 'user', text: userText });
    this.userMessage = '';
    this.scrollToBottom();

    if (!this.hasName) {
      const extractedName = this.extractNameFromMessage(userText);
      if (extractedName) {
        this.userName = extractedName;  // Aquí está el nombre limpio
        this.hasName = true;
        this.saveState();
        this.chatStorage.saveConversation(this.userName, this.messages);
        this.currentConversation = { userName: this.userName, messages: this.messages };
        await this.typeBotMessage(`¡Qué gusto conocerte, ${this.userName.split(' ')[0]}! 😊 Para ayudarte mejor, cuéntame: ¿cuáles son tus intereses, pasatiempos o aspiraciones profesionales?`);
        this.saveState();
        return;
      } else {
        await this.typeBotMessage('No entendí tu nombre. Por favor, dime cómo te llamas diciendo por ejemplo: "Me llamo Juan" o "Soy Ana".');
        return;
      }
    }

    if (this.isCollectingInterests) {
      this.interestsDescription = userText;
      this.isCollectingInterests = false;
      await this.generateQuestionsFromInterests(userText);
      if (this.questions.length > 0) {
        await this.typeBotMessage(this.questions[0].text);
      } else {
        await this.typeBotMessage('No se pudieron generar preguntas. Por favor, intenta nuevamente o describe tus intereses de otra manera.');
      }
      this.saveState();
      return;
    }

    if (this.questionIndex < this.questions.length) {
      const currentQuestion = this.questions[this.questionIndex];

      // Validar con IA en lugar de isAnswerValid()
      const score = await this.validateAnswerWithAI(currentQuestion.text, userText);

      if (score < 3) {
        this.showInvalidAnswerMsg = true;

        // Si es entre 1 y 2, respuesta confusa o muy pobre
        if (score <= 2) {
          const prompt = `Eres un orientador vocacional empático de la Universidad Técnica de Machala (UTMACH). Has hecho esta pregunta: "${currentQuestion.text}". El estudiante respondió de forma confusa: "${userText}". Reformula la pregunta de forma más clara, con un ejemplo breve (máximo 15 palabras). Usa un tono amable y directo. Solo entrega la reformulación, no expliques ni incluyas notas.`;
          try {
            const res = await this.http.post<{ response: string }>(
              'https://chatbot-orientacion.onrender.com/api/chat',
              { message: prompt }
            ).toPromise();
            const html = await this.parseMarkdown(res?.response || currentQuestion.text);
            this.messages.push({ sender: 'bot', text: res?.response || currentQuestion.text, html });
          } catch {
            await this.typeBotMessage('Déjame explicarlo mejor: ' + currentQuestion.text);
          }
        } else {
          // Si es 3, da sugerencia para mejorar
          await this.typeBotMessage("¿Podrías ampliar un poco más tu respuesta? Mientras más expresiva sea, mejor puedo ayudarte 😊");
        }

        this.scrollToBottom();
        return;
      }


      this.showInvalidAnswerMsg = false;
      this.userAnswers[currentQuestion.key] = userText;
      this.questionIndex++;

      this.saveState();

      if (this.questionIndex >= this.questions.length) {
        await this.typeBotMessage('¡Gracias por contarme tanto sobre ti! Dame un momentito para analizar todo y darte una recomendación especial 😉”');
        await this.finishAndSendToAPI();
        this.chatTerminado = true;
        return;
      }

      const nextQuestion = this.questions[this.questionIndex].text;
      const natural = await this.generateNaturalResponse(currentQuestion.text, userText, nextQuestion);
      await this.typeBotMessage(natural);
      this.saveState();
    } else if (this.awaitingFollowUp) {
      const prompt = `El estudiante respondió: "${userText}" luego de su recomendación vocacional. Responde de manera cálida y útil.`;
      try {
        const res = await this.http.post<{ response: string }>('https://chatbot-orientacion.onrender.com/api/chat', { message: prompt }).toPromise();
        await this.typeBotMessage(res?.response || 'Gracias por tu mensaje.');
      } catch {
        await this.typeBotMessage('Gracias por tu mensaje.');
      }
    }
  }

  async generateQuestionsFromInterests(interests: string): Promise<void> {
    const prompt = `Eres un orientador vocacional de UTMACH. A partir de esta descripción: "${interests}", genera 16 preguntas vocacionales variadas. Reformula cada una para que sea clara y tenga ejemplos entre paréntesis. Ejemplo: "¿Qué te gusta más al programar? (crear apps, resolver problemas, automatizar cosas)". Devuelve en formato JSON: [{"key": "pregunta1", "text": "¿...?"}, ...]`;
    try {
      const res = await this.http.post<{ response: string }>('https://chatbot-orientacion.onrender.com/api/chat', { message: prompt }).toPromise();
      const raw = (res?.response || '').replace(/```json/g, '').replace(/```/g, '').trim();
      const jsonPart = raw.split('\n').filter(line => !line.trim().startsWith('**Nota')).join('\n').trim();

      try {
        this.questions = JSON.parse(jsonPart);
      } catch (jsonErr) {
        console.error('JSON inválido:', jsonPart);
        throw new Error('Error al convertir la respuesta a JSON');
      }
    } catch (err) {
      console.error('Error generando preguntas:', err);
      await this.typeBotMessage('Hubo un problema generando las preguntas. Por favor, intenta de nuevo.');
    }
  }

  async generateNaturalResponse(pregunta: string, respuesta: string, siguiente: string): Promise<string> {
    const prompt = `Eres un orientador cálido y directo de la UTMACH. Responde con una reacción corta a lo que el estudiante dijo: "${respuesta}" a la pregunta: "${pregunta}". Luego enlaza de forma natural con esta nueva pregunta: "${siguiente}". Usa una sola oración para reaccionar (ej: “¡Qué interesante!”) y otra para introducir la siguiente. No te extiendas ni incluyas explicaciones técnicas.`;
    try {
      const res = await this.http.post<{ response: string }>('https://chatbot-orientacion.onrender.com/api/chat', { message: prompt }).toPromise();
      return res?.response || 'Gracias por tu respuesta. Vamos con otra pregunta.';
    } catch {
      return 'Gracias por tu respuesta. Vamos con otra pregunta.';
    }
  }

  async finishAndSendToAPI(): Promise<void> {
    const resumen = Object.entries(this.userAnswers).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const prompt = `Este es el resumen del estudiante:\n\n${resumen}\n\nCon base en esto, ¿qué carreras de la Universidad Técnica de Machala (UTMACH) le recomiendas? Redacta cálidamente y termina la conversación.`;

    this.isLoading = true; // 👈 Activa el spinner

    try {
      const res = await this.http.post<{ response: string }>('https://chatbot-orientacion.onrender.com/api/chat', { message: prompt }).toPromise();
      const html = await this.parseMarkdown(res?.response || 'No se pudo generar una recomendación.');
      this.messages.push({ sender: 'bot', text: res?.response || '', html });
      this.processCompleted = true;
      this.chatStorage.saveConversation(this.userName, this.messages);
      await this.http.post('https://chatbot-orientacion.onrender.com/api/guardar-resultado', {
        nombre: this.userName,
        resultado: res?.response || ''
      }).toPromise();
    } catch (err) {
      await this.typeBotMessage('Ocurrió un error al generar tu recomendación.');
    } finally {
      this.isLoading = false; // 👈 Desactiva el spinner
      this.scrollToBottom();
      this.saveState();
    }
  }

  extractNameFromMessage(message: string): string | null {
    const match = message.trim().match(/(?:me llamo|soy)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ\s]+)/i);
    if (match?.[1]) return match[1].trim();
    const words = message.trim().split(' ');
    if (words.length >= 2) return message.trim();
    if (words.length === 1 && !['hola', 'hey'].includes(words[0].toLowerCase())) return words[0];
    return null;
  }


async typeBotMessage(text: string): Promise<void> {
  const message: { sender: 'bot' | 'user'; text: string; html?: SafeHtml } = {
    sender: 'bot',
    text,
    html: await this.parseMarkdown(text),
  };
  this.messages.push(message);
  this.scrollToBottom();
}

  async parseMarkdown(text: string): Promise<SafeHtml> {
    const html = await marked.parse(text);
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  scrollToBottom(): void {
    setTimeout(() => {
      try {
        this.chatContainer.nativeElement.scrollTop = this.chatContainer.nativeElement.scrollHeight;
      } catch { }
    }, 100);
  }

  resetChat(): void {
    this.messages = [];
    this.userMessage = '';
    this.userAnswers = {};
    this.questionIndex = 0;
    this.hasName = false;
    this.userName = '';
    this.currentConversation = null;
    this.processCompleted = false;
    this.chatTerminado = false;
    this.isCollectingInterests = true;
    this.interestsDescription = '';
    this.questions = [];
    this.typeBotMessage('¡Hola! Soy tu orientador vocacional de la Universidad Técnica de Machala (UTMACH). ¿Cuál es tu nombre?');
  }

  confirmarResetChat(): void {
    const confirmado = confirm('¿Estás seguro de que deseas eliminar la conversación actual?');
    if (confirmado) {
      this.resetChat();
    }
  }

  toggleMenu(): void {
    this.showMenu = !this.showMenu;
  }

  async loadConversation(userName: string): Promise<void> {
    const savedState = localStorage.getItem(`chat-state-${userName}`);
    if (savedState) {
      try {
        const state: ChatState = JSON.parse(savedState);
        this.userName = state.userName;
        this.messages = await Promise.all(state.messages.map(async msg =>
          msg.sender === 'bot' ? { ...msg, html: await this.parseMarkdown(msg.text) } : msg
        ));
        this.userAnswers = state.userAnswers;
        this.questionIndex = state.questionIndex;
        this.questions = state.questions;
        this.interestsDescription = state.interestsDescription;
        this.hasName = state.hasName;
        this.isCollectingInterests = state.isCollectingInterests;
        this.chatTerminado = state.chatTerminado ?? false;
        this.scrollToBottom();
      } catch (error) {
        console.error('Error cargando estado guardado:', error);
        this.resetChat();
      }
    } else {
      await this.typeBotMessage('No se encontró una conversación guardada para este usuario.');
    }
  }

  deleteConversation(userName: string): void {
    if (confirm(`¿Eliminar la conversación con "${userName}"?`)) {
      this.chatStorage.deleteConversation(userName);
      localStorage.removeItem(`chat-state-${userName}`);
      this.conversations = this.chatStorage.getConversations();
      if (this.currentConversation?.userName === userName) this.resetChat();
    }
  }

  copiarConversacion(): void {
    const textoPlano = this.messages
      .map(msg => `${msg.sender === 'user' ? 'Usuario' : 'Bot'}: ${msg.text}`)
      .join('\n');

    navigator.clipboard.writeText(textoPlano).then(() => {
      alert('¡La conversación ha sido copiada al portapapeles!');
    }).catch(() => {
      alert('No se pudo copiar la conversación.');
    });
  }

  generarPDF(): void {
    const element = document.getElementById('chatTranscript');
    if (!element) return;

    const opt = {
      margin: 0.5,
      filename: `chat_${this.userName || 'estudiante'}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
      pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
    };

    html2pdf().set(opt).from(element).save();
  }

}
