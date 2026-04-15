// seed_coachdawn3.js
// Script to insert Coach Dawn 3.0 tenant into alphadome.bot_tenants
// Run: node admin/seed_coachdawn3.js

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SB_URL,
  process.env.SB_SERVICE_ROLE_KEY
);

async function seedCoachDawn() {
  const { data, error } = await supabase
    .from('bot_tenants')
    .upsert([
      {
        client_name: 'Coach Dawn 3.0',
        client_phone: '+254 748 621563',
        point_of_contact_name: 'Dawn Miracle Malingu',
        point_of_contact_phone: '+254 748 621563',
        status: 'active',
        metadata: {
          business_address: 'Nairobi, Kenya',
          business_description: 'Revolutionizing chess with AI-powered coaching, tailored training, and game insights for learners, coaches, and industry stakeholders.',
          logo: '',
          industry: 'Chess, AI Coaching, Education',
          agent_description: `Coach Dawn 3.0!\nRevolutionizing chess with AI-powered coaching, tailored training, and game insights for learners, coaches, and industry stakeholders.\nVision for Coach Dawn 3.0\nFor Learners\nPersonalized training paths, in-depth game analysis, and tactical exercises to improve every aspect of your game.\nFor Coaches\nTools to monitor student progress, automate game reviews, and create customized lesson plans with ease.\nFor Industry Stakeholders\nEnhanced tools for tournament organizers, streamers, content creators, and talent scouts, providing superior event management, player analysis, and real-time commentary.\nAdvanced Game Analysis and Tactical Feedback\nAI Chess Engine Integration\nPowered by leading chess engines like Stockfish and Leela Chess Zero, Coach Dawn 3.0 offers deep game analysis.\nVisualization Tools\nGraphical interfaces provide insights using heatmaps, evaluation bars, and move probability charts to highlight key dynamics of any position.\nPersonalized Learning and Training Pathways\nAI-Driven Learning Plans\nCoach Dawn 3.0 creates customized training routines based on your playing history and preferred style of play (aggressive, positional, etc.).\nAdaptive Lessons\nThe AI adjusts lessons dynamically based on your performance, targeting weaknesses and improving tactical, opening, and endgame skills.\nOpening Preparation and Theory Exploration\nNovel Opening Suggestions\nAdvanced algorithms offer unexplored opening ideas, helping you prepare for upcoming matches with tailored strategies.\nCloud-Based Opening Explorer\nDiscover a vast database of openings, with AI suggesting optimal continuations based on performance statistics.\nEndgame Trainer\n1\nPrecision Endgame Drills\nTrain with focused modules on essential endgame patterns like rook endgames or king and pawn endgames, learning optimal strategies for complex scenarios.\n2\nEndgame Tablebase Integration\nHandle theoretical endgame positions with perfect accuracy, guided by endgame tablebases.\nTactical Puzzle Generator\nAI-Generated Puzzles\nBased on your game history, the AI generates tactical puzzles focusing on areas of improvement.\n1\nDifficulty Levels\nPuzzles are adjusted to your skill level, gradually advancing from beginner to more complex tactics as you progress.\n2\nCoaching Support and Student Monitoring\nProgress Tracking Dashboard\nCoaches can monitor their students' progress over time, with aggregated data on game results, puzzle accuracy, and training hours.\nGame Review Automation\nAutomatically analyze student games, providing annotations, feedback, and identifying critical mistakes with AI-driven precision.\nStreaming and Commentary Support\n1\nReal-Time Game Evaluation\nDuring live events or streams, Coach Dawn 3.0 provides real-time evaluations and best-move suggestions.\n2\nEvent Management Tools\nTournament organizers can automate pairings, calculate tiebreaks, and ensure fair matchmaking, all powered by AI-driven insights.\nAnti-Cheating Mechanisms & Talent Identification\nMove Pattern Detection\nDetect engine-like behavior and flag suspicious games, ensuring the integrity of online tournaments.\nTalent Prediction\nAI analyzes player performance trends, identifying rising stars and talent potential based on consistent improvement patterns.`
        }
      }
    ], { onConflict: ['client_phone'] });
  if (error) {
    console.error('Error inserting Coach Dawn 3.0:', error.message);
  } else {
    console.log('Coach Dawn 3.0 tenant seeded:', data);
  }
}

seedCoachDawn();
