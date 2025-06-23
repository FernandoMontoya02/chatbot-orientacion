// chatbot.component.ts
import { Component, OnInit, ViewChild, ElementRef, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ChatStorageService, Conversation } from '../services/chat-storage.service';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import html2pdf from 'html2pdf.js';

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
    this.conversations = this.chatStorage.getConversations();
    this.resetChat();

    window.onbeforeunload = () => {
      localStorage.removeItem('chat-conversations');
    };
  }

  private isAnswerValid(answer: string): boolean {
    const text = answer.toLowerCase().trim();
  
    // Invalida si es muy corto
    if (text.length < 5) return false;
  
    // Detecta si solo hay símbolos o números
    if (/^[^a-záéíóúñ]+$/i.test(text)) return false;
  
    // Repeticiones tipo kkkkkk o zzzzzz
    if (/(.)\1{4,}/.test(text)) return false;
  
    // Sin vocales, sin sentido
    if (!/[aeiouáéíóú]/i.test(text)) return false;
  
    // Si tiene al menos 5 palabras, se considera válido aunque tenga frases como "no entiendo"
    if (text.split(' ').length >= 5) return true;
  
    // Frases que se consideran vacías o evasivas si están solas o casi solas
    const evasivas = [
      'no sé', 'no se', 'no entiendo', 'no comprendo', 'no te entiendo',
      'no lo sé', 'no lo se', 'no tengo idea', 'no respondí', 'no sabría decir',
      'sí', 'si', 'no', 'tal vez', 'quizás'
    ];
  
    // Verifica si la respuesta solo tiene alguna de esas evasivas
    return !evasivas.some(f => text === f || text.includes(f));
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
        await this.typeBotMessage(
          `¡Qué gusto conocerte, ${this.userName.split(' ')[0]}! 😊 Para ayudarte mejor, cuéntame: ¿cuáles son tus intereses, pasatiempos o aspiraciones profesionales?`
        );
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
      return;
    }

    if (this.questionIndex < this.questions.length) {
      const currentQuestion = this.questions[this.questionIndex];
      const isValid = this.isAnswerValid(userText);

      if (!isValid) {
        this.showInvalidAnswerMsg = true;
        const prompt = `Eres un orientador vocacional empático de la Universidad Técnica de Machala (UTMACH). Has hecho esta pregunta: "${currentQuestion.text}". El estudiante respondió de manera confusa. Reformula la pregunta con un ejemplo o explicándola mejor. Termina repitiéndola. Usa un tono amable. **No incluyas anotaciones internas ni explicaciones entre corchetes o paréntesis. Solo la reformulación para el estudiante.**`;

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

      if (this.questionIndex >= this.questions.length) {
        await this.typeBotMessage('Gracias por compartir todo eso conmigo. Déjame analizar tus respuestas...');
        await this.finishAndSendToAPI();
        this.chatTerminado = true;
        return;
      }

      const nextQuestion = this.questions[this.questionIndex].text;
      const natural = await this.generateNaturalResponse(currentQuestion.text, userText, nextQuestion);
      await this.typeBotMessage(natural);
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
    const prompt = `Eres un orientador vocacional de UTMACH. A partir de esta descripción: "${interests}", genera 16 preguntas variadas y relevantes que te ayuden a conocer mejor al estudiante para orientarlo vocacionalmente. Devuélvelas en formato JSON como: [{"key": "pregunta1", "text": "¿Pregunta 1...?"}, ...]`;

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
    const prompt = `Eres un orientador cálido y natural de la UTMACH. Comenta con empatía la respuesta: "${respuesta}" a la pregunta: "${pregunta}". Luego enlaza naturalmente con la siguiente: "${siguiente}". Usa un solo mensaje, fluido y cercano. **No incluyas notas entre corchetes ni explicaciones entre paréntesis. Solo responde como si hablaras directamente al estudiante.**`;

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
      const res = await this.http.post<{ response: string }>('hhttps://chatbot-orientacion.onrender.com/api/chat', { message: prompt }).toPromise();
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
    }finally {
      this.isLoading = false; // 👈 Desactiva el spinner
      this.scrollToBottom();
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
      } catch {}
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
      margin:       0.5,
      filename:     `chat_${this.userName || 'estudiante'}.pdf`,
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2 },
      jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' },
      pagebreak:    { mode: ['avoid-all', 'css', 'legacy'] }
    };
  
    html2pdf().set(opt).from(element).save();
  }  
  
}
