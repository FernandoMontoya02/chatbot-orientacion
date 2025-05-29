import { Component, OnInit, ViewChild, ElementRef, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ChatStorageService, Conversation } from '../services/chat-storage.service';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { QuestionService } from '../services/question.service';

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

  hasName = false;
  showMenu = false;
  isLoading = false;
  processCompleted = false;
  awaitingFollowUp = false;
  chatTerminado = false;
  questionIndex = 0;
  userAnswers: Record<string, string> = {};
  questions: { key: string; text: string }[] = [];

  constructor(
    private chatStorage: ChatStorageService,
    private questionService: QuestionService
  ) {}

  async ngOnInit(): Promise<void> {
    this.conversations = this.chatStorage.getConversations();
    await this.typeBotMessage('¡Hola! Soy tu orientador vocacional de la Universidad Técnica de Machala (UTMACH). ¿Cuál es tu nombre?');

    try {
      this.questions = await this.questionService.getRandomQuestionsByCompetence(10);
    } catch (err) {
      console.error('Error al cargar preguntas:', err);
      await this.typeBotMessage('No se pudieron cargar las preguntas de la base de datos.');
    }

    window.onbeforeunload = () => {
      if (this.messages.length > 0 && this.hasName) {
        this.chatStorage.saveConversation(this.userName, this.messages);
      }
    };
  }

  private isAnswerValid(answer: string): boolean {
    const lowAnswer = answer.toLowerCase().trim();
    const invalidPatterns = [
      /^([a-z]{2,}){3,}$/,
      'no entiendo',
      'no comprendo',
      'no se',
      'no sé',
      'no lo entiendo',
      'no entendí',
      'no te entiendo',
      '???',
      '...',
    ];

    for (const pattern of invalidPatterns) {
      if (typeof pattern === 'string') {
        if (lowAnswer.includes(pattern)) return false;
      } else {
        if (pattern.test(lowAnswer)) return false;
      }
    }

    if (lowAnswer.length <= 2) return false;
    if (/^\d+$/.test(lowAnswer)) return false;

    return true;
  }

  async sendMessage(): Promise<void> {
    if (!this.userMessage.trim() || this.chatTerminado) return;

    const userText = this.userMessage.trim();
    this.messages.push({ sender: 'user', text: userText });
    this.userMessage = '';
    this.scrollToBottom();

    if (!this.hasName) {
      this.userName = this.extractNameFromMessage(userText) || 'amigo';
      this.hasName = true;

      const intro = `
¡Qué gusto conocerte, ${this.userName.split(' ')[0]}! 😊 Estoy aquí para ayudarte a descubrir qué carrera te va mejor.
Antes, déjame hacerte algunas preguntas para conocerte mejor. ¿Listo?

${this.questions[this.questionIndex].text}
      `.trim();

      await this.typeBotMessage(intro);
      return;
    }

    if (this.questionIndex < this.questions.length) {
      const currentQuestion = this.questions[this.questionIndex];
      const isValid = this.isAnswerValid(userText);
    
      if (!isValid) {
     const reformulatedPrompt = `
Eres un orientador vocacional empático y paciente de la Universidad Técnica de Machala (UTMACH).

Estás conversando con un estudiante y le has hecho la siguiente pregunta:

"${currentQuestion.text}"

El estudiante ha respondido de forma confusa o poco clara. Sin mencionar que la respuesta fue confusa, vuelve a plantear la misma pregunta de manera más clara, sencilla y explicativa para que el estudiante la comprenda mejor. Dirígete directamente al estudiante. Usa un tono empático, conversacional y accesible. No expliques lo que hiciste, solo muestra el mensaje final que será mostrado al estudiante.
`.trim();
        try {
          const res = await this.http.post<{ response: string }>(
            'https://chatbot-orientacion.onrender.com/api/chat',
            { message: reformulatedPrompt }
          ).toPromise();
    
          const reformulated = res?.response || 'Déjame explicarlo mejor: ' + currentQuestion.text;
          const html = await this.parseMarkdown(reformulated);
          this.messages.push({ sender: 'bot', text: reformulated, html });
          this.scrollToBottom();
        } catch (err) {
          console.error('Error generando reformulación:', err);
          await this.typeBotMessage('Déjame explicarlo de otra manera: ' + currentQuestion.text);
        }
    
        return;
      }
    
      // Si la respuesta es válida
      this.userAnswers[currentQuestion.key] = userText;
      this.questionIndex++;
    
      if (this.questionIndex >= this.questions.length) {
        await this.typeBotMessage('Gracias por compartir todo eso conmigo. Déjame analizar tus respuestas...');
        await this.finishAndSendToAPI();
        this.chatTerminado = true;
        return;
      }
    
      const nextQuestion = this.questions[this.questionIndex].text;
      const naturalResponse = await this.generateNaturalResponse(
        currentQuestion.text,
        userText,
        nextQuestion
      );
      await this.typeBotMessage(naturalResponse);
    }
    
     else if (this.awaitingFollowUp) {
      const followUpPrompt = `
El estudiante ha respondido después de recibir su recomendación:

"${userText}"

Por favor, responde de forma cálida, breve y útil como orientador vocacional. Si es una expresión como "gracias", responde de forma amable.
      `.trim();

      const res = await this.http.post<{ response: string }>(
        'https://chatbot-orientacion.onrender.com/api/chat',
        { message: followUpPrompt }
      ).toPromise();

      const reply = res?.response || 'Gracias por tu mensaje.';
      await this.typeBotMessage(reply);
    }
  }

  async generateNaturalResponse(currentQuestion: string, studentAnswer: string, nextQuestion: string): Promise<string> {
    const prompt = `
Eres un orientador vocacional cálido, empático y cercano de la Universidad Técnica de Machala (UTMACH). Tu tarea es continuar la conversación con el estudiante como si hablaras naturalmente con él.

1. Comenta de forma empática y natural lo que respondió el estudiante, mostrando comprensión o validación.
2. Luego, enlaza de manera suave con la siguiente pregunta, haciéndola parte del flujo de la charla.
3. Usa un solo mensaje fluido y natural, no enumeres partes. No uses comillas.
4. No agregues detalles que el estudiante no mencionó. Solo comenta lo que dijo, valorando su respuesta y empatizando.

Pregunta: "${currentQuestion}"
Respuesta del estudiante: "${studentAnswer}"
Siguiente pregunta: "${nextQuestion}"
    `.trim();

    try {
      const res = await this.http.post<{ response: string }>(
        'https://chatbot-orientacion.onrender.com/api/chat',
        { message: prompt }
      ).toPromise();

      return res?.response || 'Gracias por tu respuesta. Vamos con otra pregunta.';
    } catch (err) {
      console.error('Error generando respuesta natural:', err);
      return 'Gracias por tu respuesta. Vamos con otra pregunta.';
    }
  }

  async finishAndSendToAPI(): Promise<void> {
    const resumen = Object.entries(this.userAnswers)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');

      const promptFinal = `
      Este es el resumen de las respuestas del estudiante. Redacta en español:
      
      ${resumen}
      
      Con base en esto, ¿qué carreras de la Universidad Técnica de Machala (UTMACH) se ajustan mejor a su perfil?
      
      Escribe como un orientador cálido, usando lenguaje sencillo, motivador y cercano. Al final, indica amablemente que esta conversación ha terminado y que si desea comenzar una nueva puede hacerlo con el botón "Nueva conversación" o recargando la página.
      `.trim();
      

    this.isLoading = true;

    try {
      const res = await this.http.post<{ response: string }>(
        'https://chatbot-orientacion.onrender.com/api/chat',
        { message: promptFinal }
      ).toPromise();

      this.isLoading = false;

      if (res?.response) {
        const html = await this.parseMarkdown(res.response);
        this.messages.push({ sender: 'bot', text: res.response, html });
        this.processCompleted = true;
        this.chatStorage.saveConversation(this.userName, this.messages);
        this.scrollToBottom();
      } else {
        await this.typeBotMessage('No se pudo generar una recomendación de carreras.');
      }
    } catch (err) {
      this.isLoading = false;
      console.error('Error al enviar resumen:', err);
      await this.typeBotMessage('Ocurrió un error al analizar tus respuestas.');
    }
  }

  async typeBotMessage(text: string): Promise<void> {
    const speed = 5;
    let displayed = '';
    const message: { sender: 'bot'; text: string; html?: SafeHtml } = { sender: 'bot', text: '' };
    this.messages.push(message);

    for (let i = 0; i < text.length; i++) {
      displayed += text[i];
      message.text = displayed;
      if (i % 5 === 0) this.scrollToBottom();
      await new Promise(r => setTimeout(r, speed));
    }
    this.scrollToBottom();
  }

  extractNameFromMessage(message: string): string | null {
    const match = message.match(/(?:me llamo|soy)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+)/i);
    return match?.[1] || message.trim().split(' ')[0] || null;
  }

  async parseMarkdown(text: string): Promise<SafeHtml> {
    const html = await marked.parse(text);
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  scrollToBottom(): void {
    setTimeout(() => {
      try {
        this.chatContainer.nativeElement.scrollTop = this.chatContainer.nativeElement.scrollHeight;
      } catch (err) {
        console.warn('Error al hacer scroll:', err);
      }
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

    this.questionService.getRandomQuestionsByCompetence(10).then(questions => {
      this.questions = questions;
      this.typeBotMessage('¡Hola! Soy tu orientador vocacional de la Universidad Técnica de Machala (UTMACH). ¿Cuál es tu nombre?');
    }).catch(err => {
      console.error('Error al cargar preguntas:', err);
      this.typeBotMessage('No se pudieron cargar las preguntas de la base de datos.');
    });
  }

  toggleMenu(): void {
    this.showMenu = !this.showMenu;
  }

  async loadConversation(userName: string): Promise<void> {
    const previous = this.chatStorage.getConversationByUser(userName);
    if (previous.length > 0) {
      this.userName = userName;
      this.hasName = true;

      this.messages = await Promise.all(previous.map(async msg =>
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
}
