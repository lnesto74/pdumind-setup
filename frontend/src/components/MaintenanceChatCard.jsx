import React, { useState, useRef, useEffect } from 'react';
import api from '../api';

const initialSuggestions = [
  'How much energy did my PDUs consume last week?',
  'Are there any overloaded circuits?',
  "What's the trend in power usage by rack?",
  'Show me any anomalies detected today.',
  'Which outlet has cycled the most in the last 24 hours?'
];

const MaintenanceChatCard = () => {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isExpanded, setIsExpanded] = useState(true);
  const [position, setPosition] = useState({ x: 20, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const cardRef = useRef(null);
  const messagesEndRef = useRef(null);
  const [suggestionsList, setSuggestionsList] = useState(initialSuggestions);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isExpanded]);

  const handleMouseDown = (e) => {
    if (e.target.closest('.chat-input')) return;
    setIsDragging(true);
    const rect = cardRef.current.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    
    const newX = e.clientX - dragOffset.x;
    const newY = e.clientY - dragOffset.y;
    
    // Keep the card within viewport bounds
    const maxX = window.innerWidth - cardRef.current.offsetWidth;
    const maxY = window.innerHeight - cardRef.current.offsetHeight;
    
    setPosition({
      x: Math.max(0, Math.min(newX, maxX)),
      y: Math.max(0, Math.min(newY, maxY))
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!inputMessage.trim()) return;

    const userMessage = inputMessage.trim();
    setInputMessage('');
    
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);

    try {
      const response = await api.post('/api/maintenance/ask', { 
        question: userMessage 
      });
      
      if (response.data.error) {
        throw new Error(response.data.error);
      }

      // Only add the response if we have an answer
      if (response.data.answer) {
        setMessages(prev => [...prev, { 
          role: 'assistant', 
          content: response.data.answer 
        }]);
        
        // Only generate follow-ups if we have a valid answer
        const followUps = generateFollowUp(userMessage, response.data.answer);
        setSuggestionsList(followUps);
        setShowSuggestions(followUps.length > 0);
      }
    } catch (error) {
      console.error('Chat error:', error);
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: 'Sorry, I encountered an error. Please try again.' 
      }]);
    }
  };

  const generateFollowUp = (text, answer = '') => {
    const userLower = text.toLowerCase();
    const answerLower = answer.toLowerCase();
    
    // Helper to check if any keywords are present
    const hasKeywords = (str, keywords) => keywords.some(k => str.includes(k));
    
    // If answer mentions specific metrics, suggest detailed analysis
    if (hasKeywords(answerLower, ['watts', 'kwh', 'voltage', 'amps'])) {
      return [
        'Show historical trend for these metrics?',
        'Compare with other similar equipment?',
        'What are normal ranges for these values?'
      ];
    }

    // If discussing problems or issues
    if (hasKeywords(answerLower, ['error', 'warning', 'alert', 'issue', 'problem'])) {
      return [
        'What caused this issue?',
        'Show similar incidents in the past?',
        'How can we prevent this?'
      ];
    }

    // Energy related queries
    if (hasKeywords(userLower, ['energy', 'power', 'consumption'])) {
      const suggestions = [
        'Energy consumption per outlet?',
        'Energy trend over the past month?',
        'Compare energy by rack?'
      ];
      
      // Add specific follow-ups based on the answer
      if (answerLower.includes('high')) {
        suggestions.push('What is causing the high consumption?');
      }
      if (answerLower.includes('trend')) {
        suggestions.push('Show detailed trend analysis?');
      }
      return suggestions.slice(0, 3); // Keep max 3 suggestions
    }

    // Performance and capacity
    if (hasKeywords(userLower, ['performance', 'capacity', 'overload'])) {
      return [
        'Which circuits are near capacity?',
        'Show peak load times?',
        'Predict future capacity needs?'
      ];
    }

    // If answer suggests anomalies
    if (hasKeywords(answerLower, ['unusual', 'anomaly', 'unexpected', 'abnormal'])) {
      return [
        'Analyze this anomaly in detail?',
        'Show similar past anomalies?',
        'What are the potential impacts?'
      ];
    }

    // Default suggestions based on general maintenance topics
    return [
      'Show system health overview?',
      'Recent maintenance history?',
      'Identify potential issues?'
    ];
  };

  return (
    <div 
      ref={cardRef}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        zIndex: 9999,
        backgroundColor: '#000',
        minWidth: '300px',
      }}
      className={`
        select-none
        ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}
      `}
    >
      <div 
        className={`
          bg-[#0a1628]/90 backdrop-blur-sm
          border border-blue-500/20
          rounded-lg shadow-lg shadow-blue-500/10
          transition-all duration-300 ease-in-out
          ${isExpanded ? 'w-[400px] h-[600px]' : 'w-[300px] h-12'}
          overflow-hidden
        `}
      >
        {/* Header - Always visible */}
        <div
          onMouseDown={handleMouseDown}
          className={`
            w-full px-4 py-2
            flex items-center justify-between
            bg-[#0a1628]/80
            border-b border-blue-500/20
            text-blue-400 font-medium
            hover:bg-blue-500/5
            transition-colors
          `}
        >
          <div className="flex items-center gap-2">
            <svg 
              className="w-5 h-5"
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={2} 
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" 
              />
            </svg>
            <span>PDUMind Assistant</span>
          </div>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 hover:bg-blue-500/10 rounded"
          >
            <svg 
              className={`w-5 h-5 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}
              fill="none" 
              viewBox="0 0 24 24" 
              stroke="currentColor"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={2} 
                d="M19 9l-7 7-7-7" 
              />
            </svg>
          </button>
        </div>

        {/* Chat Messages */}
        <div 
          className={`
            flex flex-col h-[calc(100%-3rem)]
            ${isExpanded ? 'opacity-100' : 'opacity-0'}
            transition-opacity duration-300
          `}
        >
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full space-y-6 py-4">
                <h3 className="text-lg font-medium text-blue-100">Suggested questions</h3>
                <div className="grid grid-cols-1 gap-3 w-full">
                  {initialSuggestions.map((s, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setInputMessage(s);
                        handleSubmit({ preventDefault: () => {} });
                      }}
                      className="text-left p-3 bg-[#1a2736] hover:bg-[#243548] border border-blue-500/20
                               rounded-lg transition-all duration-200 hover:border-blue-400/40
                               flex items-start space-x-3 group"
                    >
                      <span className="text-blue-400 mt-1 transform group-hover:translate-x-1 transition-transform">
                        →
                      </span>
                      <span className="text-gray-100">{s}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message, i) => (
                <div key={i}>
                  <div 
                    className={`
                      flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}
                    `}
                  >
                    <div 
                      className={`
                        max-w-[80%] p-3 rounded-lg
                        ${message.role === 'user' 
                          ? 'bg-blue-500/20 text-blue-100' 
                          : 'bg-[#1a2736] text-gray-100'
                        }
                      `}
                    >
                      {message.content}
                    </div>
                  </div>
                  {/* Show follow-up suggestions after assistant messages */}
                  {message.role === 'assistant' && i === messages.length - 1 && suggestionsList.length > 0 && (
                    <div className="mt-3 grid grid-cols-1 gap-2 pl-3">
                      {suggestionsList.map((s, idx) => (
                        <button
                          key={idx}
                          onClick={() => {
                            setInputMessage(s);
                            handleSubmit({ preventDefault: () => {} });
                          }}
                          className="text-left p-2 bg-[#1a2736]/50 hover:bg-[#243548] 
                                   border border-blue-500/20 rounded-lg transition-all duration-200 
                                   hover:border-blue-400/40 flex items-start space-x-2 group"
                        >
                          <span className="text-blue-400 transform group-hover:translate-x-1 transition-transform">
                            →
                          </span>
                          <span className="text-gray-100 text-sm">{s}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Chat Input */}
          <form 
            onSubmit={handleSubmit}
            className="chat-input p-4 border-t border-blue-500/20"
          >
            <div className="flex gap-2 relative w-full">
              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder="Ask about PDU maintenance..."
                className="
                  flex-1 px-4 py-2 rounded-lg
                  bg-[#1a2736] text-gray-100
                  border border-blue-500/20
                  focus:outline-none focus:border-blue-500/50
                  placeholder-gray-500
                "
              />
              <button
                type="submit"
                className="
                  px-4 py-2 rounded-lg
                  bg-blue-500/20 text-blue-400
                  hover:bg-blue-500/30
                  transition-colors
                "
              >
                Send
              </button>


            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default MaintenanceChatCard;
