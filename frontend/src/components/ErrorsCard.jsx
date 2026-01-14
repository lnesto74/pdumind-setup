import React, { useState } from 'react';

const ErrorsCard = ({ errors }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!errors?.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div 
        className={`
          bg-black/90 backdrop-blur-sm
          border border-red-500/20
          rounded-lg shadow-lg shadow-red-500/10
          transition-all duration-300 ease-in-out
          ${isExpanded ? 'max-h-[80vh]' : 'max-h-12'}
          overflow-hidden
        `}
      >
        {/* Header - Always visible */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`
            w-full px-4 py-2
            flex items-center justify-between
            text-red-500 font-medium
            hover:bg-red-500/5
            transition-colors
          `}
        >
          <div className="flex items-center gap-2">
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
            <span>System Errors ({errors.length})</span>
          </div>
        </button>

        {/* Error List - Only visible when expanded */}
        <div className={`
          px-4 pb-4
          text-white/90
          ${isExpanded ? 'opacity-100' : 'opacity-0'}
          transition-opacity duration-300
        `}>
          <ul className="space-y-2">
            {errors.map((error, i) => (
              <li 
                key={i}
                className="flex items-start gap-2 text-sm"
              >
                <span className="text-red-500 mt-1">•</span>
                <span>{error.name}: {error.error}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default ErrorsCard;
