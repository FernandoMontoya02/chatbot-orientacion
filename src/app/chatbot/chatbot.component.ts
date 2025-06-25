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
  chatTerminado?: boolean;  // <--- Aquí lo agregas
}


@Component({
  selector: 'app-chatbot',
  standalone: true,
  imports: [FormsModule, CommonModule],
  templateUrl: './chatbot.component.html',
  styleUrls: ['./chatbot.component.css'],
})
export class ChatbotComponent implements OnInit {
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

  constructor(private chatStorage: ChatStorageService) { }

  async ngOnInit(): Promise<void> {
    const savedState = localStorage.getItem('chat-state');
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
        this.chatTerminado = state.chatTerminado ?? false; // Restaurar si existe
      } catch (error) {
        console.error('Error al cargar estado guardado:', error);
        this.resetChat();
      }
    } else {
      this.resetChat();
    }

    this.scrollToBottom();
    this.conversations = this.chatStorage.getConversations();
  }

  private saveState(): void {
    const state: ChatState = {
      userName: this.userName,
      messages: this.messages.map(m => ({ sender: m.sender, text: m.text })),
      userAnswers: this.userAnswers,
      questionIndex: this.questionIndex,
      questions: this.questions,
      interestsDescription: this.interestsDescription,
      hasName: this.hasName,
      isCollectingInterests: this.isCollectingInterests,
      chatTerminado: this.chatTerminado // <--- Y aquí
    };
    localStorage.setItem('chat-state', JSON.stringify(state));
  }

  private isAnswerValid(answer: string): boolean {
    const text = answer.toLowerCase().trim();

    // Detecta si solo hay símbolos o números
    if (/^[^a-záéíóúñ]+$/i.test(text)) return false;

    // Repeticiones tipo kkkkkk o zzzzzz
    if (/(.)\1{4,}/.test(text)) return false;

    // Sin vocales, sin sentido
    if (!/[aeiouáéíóú]/i.test(text)) return false;

    // Frases evasivas (no válidas)
    const evasivas = [
      'no sé', 'no se', 'no entiendo', 'no comprendo', 'no te entiendo',
      'no lo sé', 'no lo se', 'no tengo idea', 'no respondí', 'no sabría decir',
      'sí', 'si', 'no', 'tal vez', 'quizás'
    ];
    if (evasivas.includes(text)) return false;

    // Si contiene al menos una palabra relevante, se acepta (aunque sea corta)
    const palabrasClave = ['innovación', 'creación', 'imaginación', 'lógica', 'análisis', 'arte', 'música', 'tecnología'];
    if (palabrasClave.some(p => text.includes(p))) return true;

    // Si tiene al menos 5 palabras, también es válida
    if (text.split(/\s+/).length >= 5) return true;

    // Si es una sola palabra significativa (no evasiva), se acepta
    if (text.length >= 4 && text.split(' ').length === 1) return true;

    return false;
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
        this.userName = extractedName;
        this.hasName = true;
        this.chatStorage.saveConversation(this.userName, this.messages);
        this.currentConversation = { userName: this.userName, messages: this.messages };
        await this.typeBotMessage(
          `¡Qué gusto conocerte, ${this.userName.split(' ')[0]}! 😊 Para ayudarte mejor, cuéntame: ¿cuáles son tus intereses, pasatiempos o aspiraciones profesionales?`
        );
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
      const isValid = this.isAnswerValid(userText);

      if (!isValid) {
        this.showInvalidAnswerMsg = true;
        const prompt = `Eres un orientador vocacional empático de la Universidad Técnica de Machala (UTMACH). Has hecho esta pregunta: "${currentQuestion.text}". El estudiante respondió de forma confusa. Reformula la pregunta de forma más clara, con un ejemplo breve (máximo 15 palabras). Usa un tono amable y directo. Solo entrega la reformulación, no expliques ni incluyas notas.`;
        try {
          const res = await this.http.post<{ response: string }>('https://chatbot-orientacion.onrender.com/api/chat', { message: prompt }).toPromise();
          const html = await this.parseMarkdown(res?.response || currentQuestion.text);
          this.messages.push({ sender: 'bot', text: res?.response || currentQuestion.text, html });
          this.scrollToBottom();
        } catch {
          await this.typeBotMessage('Déjame explicarlo mejor: ' + currentQuestion.text);
        }
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
    const speed = 5;
    let displayed = '';
    const message: { sender: 'bot'; text: string; html?: SafeHtml } = {
      sender: 'bot',
      text: '',
      html: undefined,
    };
    this.messages.push(message);

    for (let i = 0; i < text.length; i++) {
      displayed += text[i];
      message.text = displayed;
      if (i % 5 === 0) this.scrollToBottom();
      await new Promise((r) => setTimeout(r, speed));
    }

    // NUEVO: formatear Markdown
    message.html = await this.parseMarkdown(text);
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
    localStorage.removeItem('chat-state');
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
    const previous = this.chatStorage.getConversationByUser(userName);
    if (previous.length > 0) {
      this.userName = userName;
      this.hasName = true;
      this.messages = await Promise.all(previous.map(async (msg) =>
        msg.sender === 'bot' ? { ...msg, html: await this.parseMarkdown(msg.text) } : msg
      ));
      this.currentConversation = { userName, messages: this.messages };
      this.scrollToBottom();
    }
  }

  deleteConversation(userName: string): void {
    if (confirm(`¿Eliminar la conversación con "${userName}"?`)) {
      this.chatStorage.deleteConversation(userName);
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
